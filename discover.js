"use strict";


/*
 var dgram = require('dgram');


 // function startListener(callback) {
 //     var port = 1900;
 //
 //     socket = dgram.createSocket( {type: 'udp4', reuseAddr: true} );
 //     socket.on('error', function (err) {
 //
 //     });
 //     //socket.bind(port, '192.168.1.25', function () {
 //     socket.bind(port, '192.168.1.25', function () {
 //         socket.setMulticastTTL(128);
 //         socket.setBroadcast(true);
 //         socket.addMembership('239.255.255.250', '192.168.1.25'); // : s.addMembership(SSDP_ADDRESS);
 //         socket.setMulticastLoopback(true);
 //
 //         if (callback) return callback(socket);
 //     });
 //     socket.on('message', function(msg, rinfo) {
 //         if (rinfo.address != '192.168.1.20') return;
 //         msg = msg.toString();
 //     });
 // };

 // function startListener(callback) {
 //     var port = 1900;
 //
 //     socket = dgram.createSocket( {type: 'udp4', reuseAddr: true} );
 //     socket.on('error', function (err) {
 //
 //     });
 //     //socket.bind(port, '192.168.1.25', function () {
 //     socket.bind(port, function () {
 //         // XML
 //         //socket.addMembership('224.255.68.139');
 //
 //         // ZIGBEEPREFIX
 //         socket.setMulticastTTL(128);
 //         //socket.addMembership('239.255.255.250');
 //         socket.setBroadcast(true);
 //         socket.addMembership('239.255.255.250'); // : s.addMembership(SSDP_ADDRESS);
 //         socket.setMulticastLoopback(true);
 //
 //         if (callback) return callback(socket);
 //     });
 //     socket.on('message', function(msg, rinfo) {
 //         msg = msg.toString();
 //     });
 // };

 function startListener(callback) {
 var port = 1900;

 socket = dgram.createSocket( {type: 'udp4', reuseAddr: true} );
 socket.on('error', function (err) {

 });
 //socket.bind(port, '192.168.1.25', function () {
 socket.bind(port, function () {
 //socket.setMulticastTTL(128);
 socket.setBroadcast(true);
 socket.addMembership('239.255.255.250'); // : s.addMembership(SSDP_ADDRESS);
 socket.setMulticastLoopback(true);

 if (callback) return callback(socket);
 });
 socket.on('message', function(msg, rinfo) {
 if (rinfo.address != '192.168.1.20') return;
 msg = msg.toString();
 });
 };

 */

var soef = require('soef');
var request = require("request");
var os = require("os");
var ssdp = require("peer-ssdp");
var SERVER = `${os.type()}/${os.release()} UPnP/1.1 famium/0.0.1`;
var uuid = "7B8E7EE2-B755-48A6-A36A-7B8CD1EEE9B0";
//peer = ssdp.createPeer();

var yamahaManufacturer = /<manufacturer>.*yamaha.*<\/manufacturer>/i;
//var re1 = /<manufacturer>([^<]*)<\/manufacturer>/i;
//var reModelName = /<modelName>([^<]*)<\/modelName>/i;
var reFriendlyName = /<friendlyName>([^<]*)<\/friendlyName>/;

function findReceiver(callback) {
    var peer = ssdp.createPeer();
    var timer = soef.Timer(closePeer, 5000);

    function closePeer(addr, info) {
        if (peer) peer.close();
        peer = null;
        callback(addr, info);
    }

    peer.on("ready", function () {
      peer.search({ ST: "urn:schemas-upnp-org:device:MediaRenderer:1" });
    }).on("found", function (headers, address) {
        if (headers.LOCATION) {
            request(headers.LOCATION, function (error, response, body) {
                if (!error && response.statusCode == 200 && yamahaManufacturer.test(body)) {
                    //var ar = re1.exec(body);
                    var info = reFriendlyName.exec(body);
                    timer.clear();
                    closePeer(address.address, info && info.length >= 2 ? info[1] : '');
                }
            });
        }
    }).start();
}

module.exports.findReceiver = findReceiver;

function waitForNotify(ip, callback) {
    var peer = ssdp.createPeer();
    peer.on("ready", function () {
        //peer.search({ ST: 'urn:schemas-upnp-org:device:MediaRenderer:1' });
    }).on("notify", function (headers, address) {
        if (address.adress === ip) {
            callback(true);
            peer.close();
        }
    }).start();
    return peer;
}

module.exports.waitForNotify = waitForNotify;


function discoverReceiver(callback) {

    var ip = '';
    var ips = [];

    // function saveFoundIP(ip, callback) {
    //     adapter.getForeignObject("system.adapter." + adapter.namespace, function (err, obj) {
    //         obj.native.ip = ip;
    //         adapter.setForeignObject(obj._id, obj, {}, function (err, obj) {
    //             adapter.config.ip = ip;
    //             callback();
    //         });
    //     });
    // }

    function getIPAddresses() {
        // found on stackoverflow
        var interfaces = require('os').networkInterfaces();
        for (var devName in interfaces) {
            var iface = interfaces[devName];
            for (var i = 0; i < iface.length; i++) {
                var alias = iface[i];
                if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal)
                    ips.push(alias.address);
                //return alias.address;
            }
        }
        //return '0.0.0.0';
    }

    adapter.log.info('No IP configurated, trying to find a device...');
    getIPAddresses();
    if (ips.length <= 0) {
        return;
    }

    function check() {
        var ownip = ips.pop();
        var prefixIP = ownip.split('.', 3).join('.') + '.';
        if (!request) request = require('request');
    var i = 1;

    adapter.log.info(`Own IP: ${  ownip  } Range: ${  prefixIP  }1...255`);

    function doRequest() {
      if (!ip && i < 255) {
        request.post(
          {
            timeout: 200,
            method: "POST",
            uri: `http://${prefixIP}${i}/YamahaRemoteControl/ctrl`,
            body: '<YAMAHA_AV cmd="GET"><System><Config>GetParam</Config></System></YAMAHA_AV>',
          },
          function (err, response, body) {
            if (!err && response.statusCode == 200) {
                            ip = response.request.host;
              var r = body.match(
                "<Model_Name>(.*?)</Model_Name>.*?<System_ID>(.*?)</System_ID>.*?<Version>(.*?)</Version>",
                            r = r || body.match("<Model_Name>(.*?)</Model_Name>");
                            if (r && r.length >= 4) {
                                adapter.log.info('Yamaha Receiver found. IP: ' + ip + ' - Model: ' + r[1] + ' - System-ID: ' + r[2] + ' - Version: ' + r[3]);
                            } else if (r && r.length >= 2) {
                                adapter.log.info('Yamaha Receiver found. IP: ' + ip + ' - Model: ' + r[1]);
                            }
                            callback(ip);
                        }
                        i++;
                        setTimeout(doRequest, 0);
                    }
                );
            } else {
                if (ips.length && !ip) setTimeout(check, 0);
            }
        }

        doRequest();
    }

    check();
}

module.exports.discoverReceiver = discoverReceiver;
