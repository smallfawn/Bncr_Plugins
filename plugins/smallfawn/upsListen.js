/**
 * @author smallfawn
 * @name upsListen
 * @team smallfawnTeam
 * @version 1.0.0
 * @description 获取UPS状态并监控断电情况 (优化连接管理与异步回复)
 * @priority 0
 * @disable false
 * @rule ^(ups)$
 * @admin true
 * @public true
 * @classification ["工具"]
 */
const net = require('net');

const jsonSchema = BncrCreateSchema.object({
    enable: BncrCreateSchema.boolean().setTitle('是否开启ups-nut-server 监控').setDefault(false),
    ups_nut_server_ip: BncrCreateSchema.string().setTitle('ups-nut-server地址').setDescription(`格式 192.168.x.x`),
    ups_nut_server_port: BncrCreateSchema.number().setTitle('ups-nut-server端口').setDefault(3493),
    ups_nut_server_username: BncrCreateSchema.string().setTitle('ups nut server 用户名').setDefault('nut'),
    ups_nut_server_password: BncrCreateSchema.string().setTitle('ups nut server 密码').setDefault('nut'),
    ups_nut_server_ups_name: BncrCreateSchema.string().setTitle('ups nut server ups 名称').setDefault('ups0'),
});

const ConfigDB = new BncrPluginConfig(jsonSchema);

const testMap = {
    'Done and passed': '通过',
    'Done and warned': '警告',
    'Done and error': '错误',
    'Aborted': '已中止',
    'In progress': '正在进行'
};

const CONFIG = {
    REPORT_INTERVAL: 30 * 60 * 1000,
    RECONNECT_DELAY: 5000
};

// 集中管理状态，避免全局变量污染
const UPSState = {
    charge: 'N/A',
    load: 'N/A',
    runtime: 'N/A',
    inVolts: 'N/A',
    outVolts: 'N/A',
    testResult: '无记录',
    translatedTest: '无记录',
    isPowerOff: false,
    lastReportTime: 0,
    buffer: '',
    client: null,
    isConnecting: false,
    reconnectTimer: null,
    manualSession: null // 用于存储手动触发查询时的会话
};

// 1. 数据解析与逻辑处理
function handleData(rawData) {
    const vars = Object.fromEntries([...rawData.matchAll(/VAR \S+ (\S+) "(.*)"/g)].map(m => [m[1], m[2]]));
    if (!vars['ups.status']) return;
    const status = vars['ups.status'];
    const now = Date.now();
    const isCurrentlyOnBattery = status.includes('OB');

    // 更新状态缓存
    UPSState.charge = vars['battery.charge'] || 'N/A';
    UPSState.load = vars['ups.load'] || 'N/A';
    UPSState.runtime = (parseInt(vars['battery.runtime'] || 0) / 60).toFixed(1);
    UPSState.inVolts = vars['input.voltage'] || 'N/A';
    UPSState.outVolts = vars['output.voltage'] || vars['ups.voltage'] || 'N/A';
    UPSState.testResult = vars['ups.test.result'] || '无记录';
    UPSState.translatedTest = testMap[UPSState.testResult] || UPSState.testResult;
    UPSState.lastReportTime = now;

    // 格式化面板信息
    const buildMessage = () => {
        return `-----------------------------------------\n` +
            `🔋 电量: ${UPSState.charge}% | ⏳ 续航: ${UPSState.runtime}分 | 📊 负载: ${UPSState.load}%\n` +
            `⚡ 输入: ${UPSState.inVolts}V | 🔌 输出: ${UPSState.outVolts}V | 🔍 自检: ${UPSState.translatedTest}\n` +
            `-----------------------------------------`;
    };

    // 👇 如果是手动触发查询，直接使用保存的会话进行精准回复
    if (UPSState.manualSession) {
        UPSState.manualSession.reply(buildMessage());
        UPSState.manualSession = null; // 回复完毕后清空
    }

    // 状态切换逻辑 (断电/恢复)
    if (isCurrentlyOnBattery !== UPSState.isPowerOff) {
        UPSState.isPowerOff = isCurrentlyOnBattery;
        const msg = UPSState.isPowerOff ? '⚠️ 市电断开！' : '✅ 市电恢复。';
        console.log(`\n${msg} [${new Date().toLocaleString()}]`);
        sysMethod.pushAdmin({
            platform: [],
            msg: `${msg} [${new Date().toLocaleString()}]\n${buildMessage()}`
        });
    }
    // 定时汇报逻辑 (仅在断电期间)
    else if (UPSState.isPowerOff && (now - UPSState.lastReportTime >= CONFIG.REPORT_INTERVAL)) {
        const msg = buildMessage();
        console.log(`[UPS断电定时汇报]\n${msg}`);
        sysMethod.pushAdmin({
            platform: [],
            msg: `⚠️ 持续断电中...\n${msg}`
        });
    }
}

// 2. 核心连接管理
async function connect() {
    if (UPSState.isConnecting) return;
    UPSState.isConnecting = true;

    await ConfigDB.get();
    const conf = ConfigDB.userConfig;

    if (!conf?.enable) {
        UPSState.isConnecting = false;
        return;
    }

    if (UPSState.client) {
        UPSState.client.destroy();
        UPSState.client = null;
    }

    if (UPSState.reconnectTimer) {
        clearTimeout(UPSState.reconnectTimer);
        UPSState.reconnectTimer = null;
    }

    UPSState.client = new net.Socket();
    UPSState.client.setKeepAlive(true, 30000);

    UPSState.client.connect(conf.ups_nut_server_port, conf.ups_nut_server_ip, () => {
        console.log(`🟢 已连接到 UPS (${conf.ups_nut_server_ip})`);
        UPSState.isConnecting = false;
        UPSState.client.write(`USERNAME ${conf.ups_nut_server_username}\nPASSWORD ${conf.ups_nut_server_password}\n`);
        const upsName = conf.ups_nut_server_ups_name || 'ups0';
        UPSState.client.write(`LIST VAR ${upsName}\n`);
    });

    UPSState.client.on('data', (data) => {
        UPSState.buffer += data.toString();
        if (UPSState.buffer.includes('END LIST')) {
            handleData(UPSState.buffer);
            UPSState.buffer = ''; // 处理完清空缓冲区
        }
    });
    UPSState.client.on('error', (err) => {
        console.error(`🔴 UPS 连接错误: ${err.message}`);
    });

    UPSState.client.on('close', () => {
        UPSState.isConnecting = false;
        console.log(`🟡 UPS 连接断开，${CONFIG.RECONNECT_DELAY / 1000}s 后重连...`);
        // 避免重复创建多个定时器
        if (!UPSState.reconnectTimer) {
            UPSState.reconnectTimer = setTimeout(connect, CONFIG.RECONNECT_DELAY);
        }
    });
}

// 3. Cron 轮询 (后台默默获取)
sysMethod.cron.newCron('*/30 * * * * *', async () => {
    if (UPSState.client && UPSState.client.writable && !UPSState.client.destroyed) {
        const upsName = ConfigDB.userConfig?.ups_nut_server_ups_name || 'ups0';
        UPSState.client.write(`LIST VAR ${upsName}\n`);
    } else if (!UPSState.isConnecting) {
        connect();
    }
});

// 4. 插件交互入口
module.exports = async (s) => {
    await ConfigDB.get();

    if (!ConfigDB.userConfig?.enable) {
        return await s.reply('❌ UPS 监控未开启，请先在配置中启用。');
    }

    await s.reply('正在查询 UPS 实时状态，请稍候...');

    // 保存当前会话，等数据返回后在 handleData 里自动执行 reply
    UPSState.manualSession = s;
    // 设置一个 5 秒的超时保护，防止 NUT 服务器无响应导致永远不回复
    setTimeout(() => {
        if (UPSState.manualSession === s) {
            UPSState.manualSession.reply('⚠️ 查询超时，请检查 UPS 连接状态。');
            UPSState.manualSession = null;
        }
    }, 5000);

    const upsName = ConfigDB.userConfig.ups_nut_server_ups_name || 'ups0';

    if (UPSState.client && UPSState.client.writable && !UPSState.client.destroyed) {
        UPSState.client.write(`LIST VAR ${upsName}\n`);
    } else if (!UPSState.isConnecting) {
        connect();
    }
};