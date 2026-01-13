// config.js
// 该文件用于配置 WebRTC 的 ICE 服务器。
// ICE (Interactive Connectivity Establishment) 框架使用这些服务器来帮助建立对等连接，
// 特别是在复杂的网络环境（如NAT或防火墙）中。

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
