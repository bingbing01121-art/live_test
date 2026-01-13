// config.js
module.exports = {
    iceServers: [
     // 请替换为您的TURN服务器地址、用户名和密码
           {
                             'urls': 'turn:free.expressturn.com:3478',
                             'username': '000000002083647736',
                             'credential': '4rrveXxVAGyhGl7lorJasxF1aZ4='
           },
           {
            urls: 'stun:stun.l.google.com:19302'
            }
    ]
};
