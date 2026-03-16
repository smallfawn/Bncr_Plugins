/**
 * @author smallfawn
 * @name ipChange
 * @team smallfawnTeam
 * @version 1.0.0
 * @description IP变动通知
 * @rule ^(IP|IP查询)$
 * @priority 0
 * @disable false
 * @admin true
 * @public true
 * @classification ["工具"]
 */


const axios = require('axios');
const getIPApi = "https://4.ipw.cn/"
const DB = new BncrDB('smallfawnDB');
async function getIP() {
    let { data: newip } = await axios.get(getIPApi)
    return newip;
}
// ================= 定时任务（每日8点推送状态）=================
sysMethod.cron.newCron('0 * * * *', async () => {
    let newip = await getIP();
    let ip = await DB.get('ip');
    if (!ip) {
        await DB.set('ip', newip);

    } else {
        let message = ``;
        if (ip != newip) {
            message = `IP已变动，当前IP为：${newip}`;
            await DB.set('ip', newip);
            sysMethod.pushAdmin({
                platform: [],
                msg: message,
            });
        }

    }

});



// ================= 命令入口 =================
module.exports = async (s) => {
    let newip = await getIP();
    await s.reply({
        msg: `当前IP为：${newip}`
    })
};