/**
 * @author smallfawn
 * @name getPrinterStatus
 * @team smallfawnTeam
 * @version 1.0.0
 * @description 定时每天8点获取打印机状态,仅测试EPSON L4266,理论上支持WIFI的打印机都可以
 * @rule ^(打印机|打印机状态)$
 * @priority 0
 * @disable false
 * @admin true
 * @public true
 * @classification ["工具"]
 */


const ipp = require('ipp');
const { promisify } = require('util');
const path = require('path');
const jsonSchema = BncrCreateSchema.object({
    enable: BncrCreateSchema.boolean().setTitle('是否开启该打印机脚本').setDefault(false),
    print_url: BncrCreateSchema.string().setTitle('打印机IPP地址').setDescription(`格式 http://192.168.x.x:631/ipp/print`),
    test_enable: BncrCreateSchema.boolean().setTitle('是否开启每周自动打印测试图防止堵头').setDefault(false),
});
const ConfigDB = new BncrPluginConfig(jsonSchema);

let CONFIG = {
    PRINTER_URL: 'http://192.168.x.x:631/ipp/print',   // 默认值，实际会被配置覆盖
    TEST_IMAGE: path.join(__dirname, 'assets', 'demo.jpg'),
}

// ================= 打印机服务（每次操作动态创建 Printer）=================
class PrinterService {
    async _execute(operation, message) {
        const url = CONFIG.PRINTER_URL;
        if (!url) {
            throw new Error('打印机 URL 未配置，请先设置 print_url');
        }
        const printer = ipp.Printer(url);
        const execute = promisify(printer.execute).bind(printer);
        return await execute(operation, message);
    }

    async getStatus() {
        const msg = {
            "operation-attributes-tag": {
                "requesting-user-name": "NodeJS-Monitor",
                "attributes-charset": "utf-8",
                "attributes-natural-language": "zh-cn",
                "printer-uri": CONFIG.PRINTER_URL,      // 必须使用当前 URL
                "requested-attributes": [
                    "printer-is-accepting-jobs",
                    "printer-state",
                    "printer-state-reasons",
                    "marker-names",
                    "marker-levels"
                ]
            }
        };
        const res = await this._execute("Get-Printer-Attributes", msg);
        const attrs = res["printer-attributes-tag"] || {};

        // 映射表
        const reasonMap = {
            'none': '就绪',
            'media-empty-report': '缺纸',
            'media-jam': '卡纸',
            'marker-supply-low': '墨水余量低',
            'marker-supply-empty': '墨水耗尽',
            'cover-open': '扫描盖未关好',
            'door-open': '维修门未关严',
            'offline': '打印机离线'
        };
        const stateMap = { idle: 'idle', processing: 'processing', stopped: 'stopped' };
        const colorMap = { 'Black ink': '黑', 'Cyan ink': '青', 'Magenta ink': '洋红', 'Yellow ink': '黄' };

        const rawReasons = attrs["printer-state-reasons"] || [];
        const reasonList = Array.isArray(rawReasons) ? rawReasons : [rawReasons];
        const warnings = reasonList
            .filter(r => r !== 'none')
            .map(r => reasonMap[r] || `其他故障 (${r})`);

        const ink = {};
        if (attrs["marker-names"] && attrs["marker-levels"]) {
            attrs["marker-names"].forEach((name, i) => {
                ink[colorMap[name] || name] = attrs["marker-levels"][i];
            });
        }

        return {
            isAccepting: attrs["printer-is-accepting-jobs"],
            warnings: warnings.length ? warnings : ["状态正常"],
            deviceState: stateMap[attrs["printer-state"]] || `未知状态 (${attrs["printer-state"]})`,
            inkLevels: ink
        };
    }

    async printJob(filename, buffer, mimetype, copies = 1) {
        const msg = {
            "operation-attributes-tag": {
                "requesting-user-name": "Smart-Print-Terminal",
                "job-name": filename,
                "document-format": mimetype,
                "printer-uri": CONFIG.PRINTER_URL      // 必须使用当前 URL
            },
            "job-attributes-tag": {
                copies,
                sides: "one-sided",
                media: "iso_a4_210x297mm"
            },
            data: buffer
        };
        const res = await this._execute("Print-Job", msg);
        if (res.statusCode !== 'successful-ok') {
            throw new Error(`打印机拒绝任务: ${res.statusCode}`);
        }
        return res["job-attributes-tag"]["job-id"];
    }
}

// 创建打印机服务实例（单例）
const printer = new PrinterService();

/**
 * 获取打印机状态并格式化为消息字符串
 */
async function getPrinterStatus() {
    let status;
    try {
        status = await printer.getStatus();
    } catch (e) {
        console.log(e);
        status = { deviceState: 'unknown', warnings: ['无法获取状态'], inkLevels: {} };
    }
    const stateMap = { idle: '空闲', processing: '处理中', stopped: '已停止' };
    const deviceStateZh = stateMap[status.deviceState] || status.deviceState;
    const warningsStr = status.warnings.join('.');
    const inkStr = Object.entries(status.inkLevels)
        .map(([name, level]) => `${name} ${level}%`)
        .join('/') || '无余墨信息';
    return `打印机状态：${deviceStateZh}，警告：${warningsStr}，墨量：${inkStr}`;
}

// ================= 定时任务（每日检查并推送状态）=================
sysMethod.cron.newCron('0 8 * * *', async () => {
    // 定时任务中重新读取配置，确保 URL 是最新的
    await ConfigDB.get();
    if (ConfigDB?.userConfig?.print_url) {
        CONFIG.PRINTER_URL = ConfigDB.userConfig.print_url;
    }
    // 如果未开启脚本，则不执行推送（可选）
    if (!ConfigDB?.userConfig?.enable) {
        console.log('定时任务：打印机脚本未启用，跳过');
        return;
    }
    let message = await getPrinterStatus();
    sysMethod.pushAdmin({
        //推送所有平台
        platform: [],

        msg: message,
    });
});

// ================= 命令入口 =================
module.exports = async (s) => {
    // 每次命令都重新加载配置
    await ConfigDB.get();
    if (!Object.keys(ConfigDB.userConfig).length) {
        sysMethod.startOutLogs('未配置打印机脚本,退出.');
        return;
    }
    if (!ConfigDB?.userConfig?.enable) {
        return sysMethod.startOutLogs('未启用打印机脚本 退出.');
    }
    if (!ConfigDB?.userConfig?.print_url) {
        return sysMethod.startOutLogs('未输入打印机IPP接口 退出.');
    }
    // 更新全局配置
    CONFIG.PRINTER_URL = ConfigDB.userConfig.print_url;

    let message = await getPrinterStatus();
    await s.reply({
        msg: message,
    });
}