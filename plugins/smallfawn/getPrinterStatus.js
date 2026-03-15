/**
 * @author smallfawn
 * @name getPrinterStatus
 * @team smallfawnTeam
 * @version 1.0.0
 * @description 定时每天8点获取打印机状态,仅测试EPSON L4266,理论上支持WIFI的打印机都可以
 * @rule ^(打印机|打印机状态|打印测试图片)$
 * @priority 0
 * @disable false
 * @admin true
 * @public true
 * @classification ["工具"]
 */

const ipp = require('ipp');
const { promisify } = require('util');
const axios = require('axios');
const jsonSchema = BncrCreateSchema.object({
    enable: BncrCreateSchema.boolean().setTitle('是否开启该打印机脚本').setDefault(false),
    print_url: BncrCreateSchema.string().setTitle('打印机IPP地址').setDescription(`格式 http://192.168.x.x:631/ipp/print`),
    test_enable: BncrCreateSchema.boolean().setTitle('是否开启每周自动打印测试图防止堵头').setDefault(false),
    test_image: BncrCreateSchema.string().setTitle('测试打印图片地址').setDefault('https://gh-proxy.org/https://raw.githubusercontent.com/smallfawn/Bncr_Plugins/refs/heads/main/plugins/smallfawn/assets/printer_test.jpeg'),
});
const ConfigDB = new BncrPluginConfig(jsonSchema);

// ================= 打印机服务（每次操作需传入 URL）=================
class PrinterService {
    async _execute(operation, message, url) {
        if (!url) {
            throw new Error('打印机 URL 未提供，请先设置 print_url');
        }
        const printer = ipp.Printer(url);
        const execute = promisify(printer.execute).bind(printer);
        return await execute(operation, message);
    }

    async getStatus(url) {
        const msg = {
            "operation-attributes-tag": {
                "requesting-user-name": "NodeJS-Monitor",
                "attributes-charset": "utf-8",
                "attributes-natural-language": "zh-cn",
                "printer-uri": url,      // 使用传入的 URL
                "requested-attributes": [
                    "printer-is-accepting-jobs",
                    "printer-state",
                    "printer-state-reasons",
                    "marker-names",
                    "marker-levels"
                ]
            }
        };
        const res = await this._execute("Get-Printer-Attributes", msg, url);
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

    async printJob(filename, buffer, mimetype, url, copies = 1) {
        const msg = {
            "operation-attributes-tag": {
                "requesting-user-name": "Smart-Print-Terminal",
                "job-name": filename,
                "document-format": mimetype,
                "printer-uri": url      // 使用传入的 URL
            },
            "job-attributes-tag": {
                copies,
                sides: "one-sided",
                media: "iso_a4_210x297mm"
            },
            data: buffer
        };
        const res = await this._execute("Print-Job", msg, url);
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
 * 内部自动读取最新配置中的 URL
 */
async function getPrinterStatus() {
    await ConfigDB.get(); // 确保配置最新
    const url = ConfigDB.userConfig.print_url;
    if (!url) {
        return '打印机 URL 未配置';
    }
    let status;
    try {
        status = await printer.getStatus(url);
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

// ================= 定时任务（每日8点推送状态）=================
sysMethod.cron.newCron('0 8 * * *', async () => {
    await ConfigDB.get();
    if (!ConfigDB.userConfig?.enable) {
        console.log('定时任务：打印机脚本未启用，跳过');
        return;
    }
    if (!ConfigDB.userConfig?.print_url) {
        console.log('未配置打印地址，跳过推送');
        return;
    }
    const message = await getPrinterStatus(); // 内部会使用最新 URL
    sysMethod.pushAdmin({
        platform: [],
        msg: message,
    });
});

// ================= 定时任务（每周日18:31打印测试图片）=================
sysMethod.cron.newCron('31 18 * * 0', async () => {
    await ConfigDB.get();
    if (!ConfigDB.userConfig?.enable) {
        console.log('定时任务：打印机脚本未启用，跳过');
        return;
    }
    if (!ConfigDB.userConfig?.print_url) {
        console.log('未配置打印地址，跳过打印测试图片');
        return;
    }
    if (!ConfigDB.userConfig?.test_enable) {
        console.log('未启用打印测试图片功能，跳过');

        return;
    }
    if (!ConfigDB.userConfig?.test_image) {
        console.log('测试图片地址未配置，跳过打印');
        sysMethod.pushAdmin({
            platform: [],
            msg: '定时任务：打印机脚本[打印测试图片]未配置图片地址，跳过打印',
        });
        return;
    }

    const res = await printTest(); // printTest 内部会读取最新配置
    sysMethod.pushAdmin({
        platform: [],
        msg: res,
    });
});

/**
 * 执行测试图片打印（内部读取最新配置）
 */
async function printTest() {
    await ConfigDB.get();
    const imageUrl = ConfigDB.userConfig.test_image;
    const printUrl = ConfigDB.userConfig.print_url;
    if (!imageUrl || !printUrl) {
        return '测试图片地址或打印机 URL 未配置';
    }

    // 从 URL 提取文件名，简单处理
    let filename = imageUrl.split('/').pop() || 'test_print.jpg';
    if (!filename.includes('.')) filename += '.jpg';

    try {
        // 下载图片（二进制流）
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        // 确定 MIME 类型
        let contentType = response.headers['content-type'];
        if (!contentType || !contentType.startsWith('image/')) {
            if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
                contentType = 'image/jpeg';
            } else {
                contentType = 'image/jpeg'; // 默认
            }
        }

        // 调用打印机执行打印（传入 URL）
        const jobId = await printer.printJob(filename, buffer, contentType, printUrl, 1);
        console.log(`测试图片打印任务已提交，Job ID: ${jobId}`);

        // 打印后获取最新状态
        let status = await getPrinterStatus();
        return `测试图片打印成功，任务ID: ${jobId}\n${status}`;
    } catch (error) {
        console.error('打印测试图片失败:', error);
        let errorMsg = `打印测试图片失败: ${error.message}`;
        // 尝试获取当前状态
        try {
            let status = await getPrinterStatus();
            errorMsg += `\n当前打印机状态: ${status}`;
        } catch (e) {
            errorMsg += `\n获取打印机状态也失败: ${e.message}`;
        }
        return errorMsg;
    }
}

// ================= 命令入口 =================
module.exports = async (s) => {
    await ConfigDB.get();
    if (!Object.keys(ConfigDB.userConfig).length) {
        await s.reply({ msg: '未配置打印机脚本,退出.' });
        return;
    }
    if (!ConfigDB.userConfig?.enable) {
        await s.reply({ msg: '未启用打印机脚本 退出.' });
        return
    }
    if (!ConfigDB.userConfig?.print_url) {
        await s.reply({ msg: '未输入打印机IPP接口 退出.' });
        return
    }

    const msg = s.getMsg();
    if (msg === '打印测试图片') {
        await s.reply({ msg: '开始打印测试图片...请稍后' });
        if (!ConfigDB.userConfig?.test_enable) {
            await s.reply({ msg: '未启用打印测试图片，跳过打印' });
            return;
        }
        if (!ConfigDB.userConfig?.test_image) {
            await s.reply({ msg: '未配置图片地址，跳过打印' });
            return;
        }
        const res = await printTest();
        await s.reply({ msg: res });
    } else if (msg === '打印机状态' || msg === '打印机') {
        const message = await getPrinterStatus();
        await s.reply({ msg: message });
    }
};