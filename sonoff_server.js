module.exports.createServer = function (config) {


    const ws = require("nodejs-websocket");
    const log = require('./helpers/logger');



    //set initialized parameters
    var state = {
        knownDevices: [],
        connections: [],
        listeners: {
            onDeviceConnectedListeners: [],
            onDeviceDisconnectedListeners: [],
            onDeviceUpdatedListeners: []
        }
    };



    // Find the device in known devices.
    state.getDeviceById = (deviceId) => {
        return state.knownDevices.find(d => d.id == deviceId);
    };



    state.getDeviceByParentId = (deviceId) => {
        return state.knownDevices.find(d => d.parentId == deviceId);
    };



    state.updateKnownDevice = (device) => {
        var updated = false;

        for (var i = 0; i < state.knownDevices.length; i++) {
            if (state.knownDevices[i].id == device.id) {
                state.knownDevices[i] = device;
                updated = true;
                callDeviceListeners(state.listeners.onDeviceUpdatedListeners, device);
            }
        }
        if (!updated) {
            state.knownDevices.push(device);
            callDeviceListeners(state.listeners.onDeviceConnectedListeners, device);
        }
    };



    function callDeviceListeners(listeners, device) {
        const deviceListeners = listeners[device.id];
        if (!deviceListeners)
            return;
        deviceListeners.forEach(listener => listener(device.state));
    }



    function addDeviceListener(listeners, deviceId, listener) {
        if (!listeners[deviceId]) {
            listeners[deviceId] = [listener];
        } else {
            listeners[deviceId].push(listener);
        }
    }



    state.pushMessage = a => {

        var request = {
            "apikey": "111111111-1111-1111-1111-111111111111",
            "action": a.action,
            "deviceid": a.target,
            "params": a.value,
            "userAgent": "app",
            "sequence": Date.now().toString(),
            "ts": 0,
            "from": "app"
        };
        var r = JSON.stringify(request);
        log.log('REQ | WS | APP | ' + r);
        var device = state.getDeviceById(a.device);
        if (!device.messages) device.messages = [];
        device.messages.push(request);
        device.connection.conn.sendText(r);
    };




    function addConnection(connection) {
        var conn = connection.conn;
        var connId = conn.socket.remoteAddress + ':'  + conn.socket.remotePort;
        connection.isAlive = true;
        state.connections[connId] = connection;
        log.log(`WS | addConnection |`);


        console.log(config.IS_ALIVE_CHECK_ENABLED);
        if (config.IS_ALIVE_CHECK_ENABLED === "ON") {
            connection.isAliveIntervalId = setInterval(() => {
                if (connection.conn.readyState == connection.conn.CONNECTING) return;
                if (!connection.isAlive) {
                    clearInterval(connection.isAliveIntervalId);
                    return connection.conn.close(408, "connection timed out");
                }
                connection.isAlive = false;
                conn.sendPing();
                log.log(`WS | sendPing |`);
            }, config.IS_ALIVE_CHECK_INTERVAL);


            connection.conn.on("pong", () => {
                connection.isAlive = true;
                log.log(`WS | pong |`);
            });
        }
    }



    // ----------- sonoff server ------------------------
    // setup a server, that will respond to the SONOFF requests
    // this is the replacement for the SONOFF cloud!
    var wsOptions = {
        secure: true,
        key: config.ssl_key,
        cert: config.ssl_cert,
    };

    const wsServer = ws.createServer(wsOptions, function (conn) {
        log.log("WS | Server is up %s:%s to %s:%s", config.SERVER_IP, config.WEBSOCKET_PORT, conn.socket.remoteAddress, conn.socket.remotePort);

        conn.on("text", function (str) {
            var data = JSON.parse(str);
            log.log('REQ | WS | DEV | %s', JSON.stringify(data));
            res = {
                "error": 0,
                "deviceid": data.deviceid,
                // "apikey": "123456789-1234-1234-1234-123456789123"
                "apikey": "111111111-1111-1111-1111-111111111111"

            };
            if (data.action) {
                switch (data.action) {
                    case 'date':
                        res.date = new Date().toISOString();
                        break;
                    case 'query':
                        //device wants information
                        var device = state.getDeviceById(data.deviceid);
                        if (!device) {
                            device = state.getDeviceByParentId(data.deviceid);
                            if (!device) {
                                log.error('ERR | WS | Unknown device ', data.deviceid);
                                break;
                            }
                        }
                        /*if(data.params.includes('timers')){
                         log.log('INFO | WS | Device %s asks for timers',device.id);
                         if(device.timers){
                          res.params = [{timers : device.timers}];
                         }
                        }*/
                        res.params = {};
                        data.params.forEach(p => {
                            res.params[p] = device[p];
                        });
                        break;
                    case 'update':
                        // device wants to update its state
                        if (typeof data.params.switches == 'undefined') {
                            // Single switch
                            var device = state.getDeviceById(data.deviceid);
                            if (!device) {
                                log.error('ERR | WS | Unknown device ', data.deviceid);
                            } else {
                                device.state = data.params.switch;
                                device.rawMessageLastUpdate = data;
                                device.rawMessageLastUpdate.timestamp = Date.now();
                                log.log('WS | DeviceUpdated device ', data);

                                state.updateKnownDevice(device);
                            }
                        } else {
                            // Multiple switches, look for parent
                            var device = state.getDeviceByParentId(data.deviceid);
                            if (!device) {
                                log.error('ERR | WS | Unknown device ', data.deviceid);
                            } else {
                                for (i = 0; i < data.params.switches.length; i++) {
                                    var device = state.getDeviceById(data.deviceid + '-' + i);
                                    device.state = data.params.switches[i].switch;
                                    device.rawMessageLastUpdate = data;
                                    device.rawMessageLastUpdate.timestamp = Date.now();
                                    state.updateKnownDevice(device);
                                }
                            }
                        }
                        break;
                    case 'register':
                        var connection = {
                            conn: conn,
                            devices: []
                        }

                        if (data.model == 'PSF-B04-GL') {
                            //register for devices appending the outlet to the deviceId
                            for (i = 0; i < 4; i++) {
                                var device = {
                                    id: data.deviceid + '-' + i,
                                    parentId: data.deviceid,
                                    outlet: i
                                };
                                device.version = data.romVersion;
                                device.model = data.model;
                                device.connection = connection;
                                device.rawMessageRegister = data;
                                device.rawMessageRegister.timestamp = Date.now();
                                connection.devices.push(device);
                                state.updateKnownDevice(device);
                                log.log('INFO | WS | Device %s registered', device.id);
                                log.log(`WS | deviceInfo | ${data}`);
                                log.log(data);

                            }
                            //All devices share connection
                            addConnection(connection);
                        } else {
                            var device = {
                                id: data.deviceid
                            };

                            device.version = data.romVersion;
                            device.model = data.model;
                            device.connection = connection;
                            device.rawMessageRegister = data;
                            device.rawMessageRegister.timestamp = Date.now();
                            connection.devices.push(device);
                            addConnection(connection);
                            state.updateKnownDevice(device);
                            log.log('INFO | WS | Device %s registered', device.id);
                        }
                        break;
                    default: log.error('TODO | Unknown action "%s"', data.action); break;
                }
            } else {
                if (data.sequence && data.deviceid) {
                    var device = state.getDeviceById(data.deviceid);
                    if (!device) {
                        // Look for parent
                        device = state.getDeviceByParentId(data.deviceid);
                        if (!device) {
                            log.error('ERR | WS | Unknown device ', data.deviceid);
                        } else {
                            // Look for message
                            for (i = 0; i < 4; i++) {
                                device = state.getDeviceById(data.deviceid + '-' + i);
                                if (device.messages) {
                                    var message = device.messages.find(item => item.sequence == data.sequence);
                                    if (message) {
                                        device.messages = device.messages.filter(function (item) {
                                            return item !== message;
                                        })
                                        device.state = message.params.switches[0].switch;
                                        state.updateKnownDevice(device);
                                        log.log('INFO | WS | APP | action has been accnowlaged by the device ' + JSON.stringify(data));
                                        break;;
                                    }
                                }
                            }
                        }
                    } else {
                        if (device.messages) {
                            var message = device.messages.find(item => item.sequence == data.sequence);
                            if (message) {
                                device.messages = device.messages.filter(function (item) {
                                    return item !== message;
                                })
                                device.state = message.params.switch;
                                state.updateKnownDevice(device);
                                log.log('INFO | WS | APP | action has been acknowledged by the device ' + JSON.stringify(data));
                            } else {
                                log.error('ERR | WS | No message send, but received an anser', JSON.stringify(data));
                            }
                        } else {
                            log.error('ERR | WS | No message send, but received an anser', JSON.stringify(data));
                        }
                    }
                } else {
                    log.error('TODO | WS | Not data action frame\n' + JSON.stringify(data));
                }
            }
            var r = JSON.stringify(res);
            log.log('RES | WS | DEV | ' + r);
            conn.sendText(r);
        });

       conn.on("close", function (code, reason) {
            var connId = conn.socket.remoteAddress + ':'  + conn.socket.remotePort;
            state.connections[connId].devices.forEach((device, index) => {
                log.log("Device %s disconnected", device.id);
                callDeviceListeners(state.listeners.onDeviceDisconnectedListeners, device);
                device.connnection = undefined;
            });

            clearInterval(state.connections[connId].isAliveIntervalId);
            delete state.connections[connId];
        });
        conn.on("error", function (error) {
            log.error("Connection error: ", error);
        });
    }).listen(config.WEBSOCKET_PORT);





    return {
        //currently all known devices are returned with a hint if they are currently connected
        getConnectedDevices: () => {
            return state.knownDevices.map(x => {
                return { id: x.id, state: x.state, parentId: x.parentId, outlet: x.outlet, model: x.model, kind: x.kind, version: x.version, isConnected: (typeof x.connection !== 'undefined'), isAlive: x.connection.isAlive, rawMessageRegister: x.rawMessageRegister, rawMessageLastUpdate: x.rawMessageLastUpdate }
            });
        },



        getDeviceState: (deviceId) => {
            var d = state.getDeviceById(deviceId);

            if (!d || (typeof d.connection == 'undefined')) return "disconnected";
            return d.state;
        },



        turnOnDevice: (deviceId) => {
            var d = state.getDeviceById(deviceId);
            if (!d || (typeof d.connection == 'undefined')) return "disconnected";

            if (typeof d.outlet == 'undefined') {
                state.pushMessage({ action: 'update', value: { switch: "on" }, target: deviceId, device: deviceId });
            } else {
                state.pushMessage({ action: 'update', value: { switches: [{ switch: "on", outlet: Number(d.outlet) }]}, target: d.parentId, device: deviceId });
            }

            return "on";
        },



        turnOffDevice: (deviceId) => {
            var d = state.getDeviceById(deviceId);
            if (!d || (typeof d.connection == 'undefined')) return "disconnected";

            if (typeof d.outlet == 'undefined') {
                state.pushMessage({ action: 'update', value: { switch: "off" }, target: deviceId, device: deviceId });
            } else {
                state.pushMessage({ action: 'update', value: { switches: [{ switch: "off", outlet: Number(d.outlet) }]}, target: d.parentId, device: deviceId });
            }

            return "off";
        },

        registerOnDeviceConnectedListener: (deviceId, listener) => {
            addDeviceListener(state.listeners.onDeviceConnectedListeners, deviceId, listener);
        },

        registerOnDeviceDisconnectedListener: (deviceId, listener) => {
            addDeviceListener(state.listeners.onDeviceDisconnectedListeners, deviceId, listener);
        },

        registerOnDeviceUpdatedListener: (deviceId, listener) => {
            addDeviceListener(state.listeners.onDeviceUpdatedListeners, deviceId, listener);
        },

        close: () => {
            log.log("Stopping server");
            for(key in state.connections) {
                var connection = state.connections[key];
                connection.conn.socket.setTimeout(100, function() {
                    if(connection) {
                       connection.conn.socket.destroy();
                    }
                });

                connection.conn.close();
            }

            wsServer.close(function () {
                log.log('WS Server stopped');
            });
            log.log("Stopped server");
        }
    }
}
