// vim: ts=4:sw=4:expandtab
/* global libsignal */

(function () {
    'use strict';

    const ns = self.relay = self.relay || {};

    ns.OutgoingMessage = class OutgoingMessage {

        constructor(server, timestamp, message) {
            console.assert(message instanceof ns.protobuf.Content);
            this.server = server;
            this.timestamp = timestamp;
            this.message = message;
            this.sent = [];
            this.errors = [];
            this.created = Date.now();
            this._listeners = {};
        }

        on(event, callback) {
            let handlers = this._listeners[event];
            if (!handlers) {
                handlers = this._listeners[event] = [];
            }
            handlers.push(callback);
        }

        async emit(event) {
            const handlers = this._listeners[event];
            if (!handlers) {
                return;
            }
            const args = Array.from(arguments).slice(1);
            for (const callback of handlers) {
                try {
                    await callback.apply(this, args);
                } catch(e) {
                    console.error("Event callback error:", e);
                }
            }
        }

        async emitError(addr, reason, error) {
            if (!error || error instanceof ns.ProtocolError && error.code !== 404) {
                error = new ns.OutgoingMessageError(addr, this.message.toArrayBuffer(),
                                                    this.timestamp, error);
            }
            error.addr = addr;
            error.reason = reason;
            const entry = {
                timestamp: Date.now(),
                error
            };
            this.errors.push(entry);
            await this.emit('error', entry);
        }

        async emitSent(addr) {
            const entry = {
                timestamp: Date.now(),
                addr
            };
            this.sent.push(entry);
            await this.emit('sent', entry);
        }

        async reloadDevicesAndSend(addr, recurse) {
            const deviceIds = await ns.store.getDeviceIds(addr);
            return await this.doSendMessage(addr, deviceIds, recurse, {});
        }

        async getKeysForAddr(addr, updateDevices, reentrant) {
            const _this = this;
            async function handleResult(response) {
                const jobs = [];
                for (const x of response.devices) {
                    jobs.push(async function(device) {
                        device.identityKey = response.identityKey;
                        if (updateDevices === undefined || updateDevices.indexOf(device.deviceId) > -1) {
                            const address = new libsignal.SignalProtocolAddress(addr, device.deviceId);
                            const builder = new libsignal.SessionBuilder(ns.store, address);
                            try {
                                await builder.processPreKey(device);
                            } catch(e) {
                                if (e.message === "Identity key changed") {
                                    if (!reentrant) {
                                        await _this.emit('keychange', addr, device.identityKey);
                                        await _this.getKeysForAddr(addr, updateDevices, /*reentrant*/ true);
                                    } else {
                                        throw new ns.OutgoingIdentityKeyError(addr,
                                            _this.message.toArrayBuffer(), _this.timestamp,
                                            device.identityKey);
                                    }
                                } else {
                                    throw e;
                                }
                            }
                        }
                    }(x));
                }
                await Promise.all(jobs);
            }

            if (updateDevices === undefined) {
                return await (handleResult(await this.server.getKeysForAddr(addr)));
            } else {
                for (const device of updateDevices) {
                    /* NOTE: This must be serialized due to a server bug. */
                    try {
                        await handleResult(await _this.server.getKeysForAddr(addr, device));
                    } catch(e) {
                        if (e instanceof ns.ProtocolError && e.code === 404 && device !== 1) {
                            await _this.removeDeviceIdsForAddr(addr, [device]);
                        } else {
                            throw e;
                        }
                    }
                }
            }
        }

        async transmitMessage(addr, jsonData, timestamp) {
            try {
                return await this.server.sendMessages(addr, jsonData, timestamp);
            } catch(e) {
                if (e instanceof ns.ProtocolError && (e.code !== 409 && e.code !== 410)) {
                    // 409 and 410 should bubble and be handled by doSendMessage
                    // 404 should throw UnregisteredUserError
                    // all other network errors can be retried later.
                    if (e.code === 404) {
                        throw new ns.UnregisteredUserError(addr, e);
                    }
                    throw new ns.SendMessageError(addr, jsonData, e, timestamp);
                }
                throw e;
            }
        }

        getPaddedMessageLength(messageLength) {
            var messageLengthWithTerminator = messageLength + 1;
            var messagePartCount = Math.floor(messageLengthWithTerminator / 160);
            if (messageLengthWithTerminator % 160 !== 0) {
                messagePartCount++;
            }
            return messagePartCount * 160;
        }

        async doSendMessage(addr, deviceIds, recurse) {
            const ciphers = {};
            const plaintext = this.message.toArrayBuffer();
            const paddedPlaintext = new Uint8Array(
                this.getPaddedMessageLength(plaintext.byteLength + 1) - 1
            );
            paddedPlaintext.set(new Uint8Array(plaintext));
            paddedPlaintext[plaintext.byteLength] = 0x80;
            let messages;
            try {
                messages = await Promise.all(deviceIds.map(id => {
                    const address = new libsignal.SignalProtocolAddress(addr, id);
                    const sessionCipher = new libsignal.SessionCipher(ns.store, address);
                    ciphers[address.getDeviceId()] = sessionCipher;
                    return this.encryptToDevice(address, paddedPlaintext, sessionCipher);
                }));
            } catch(e) {
                this.emitError(addr, "Failed to create message", e);
                return;
            }
            try {
                await this.transmitMessage(addr, messages, this.timestamp);
            } catch(e) {
                if (e instanceof ns.ProtocolError && (e.code === 410 || e.code === 409)) {
                    if (!recurse) {
                        this.emitError(addr, "Hit retry limit attempting to reload device list", e);
                        return;
                    }
                    if (e.code === 409) {
                        await this.removeDeviceIdsForAddr(addr, e.response.extraDevices);
                    } else {
                        await Promise.all(e.response.staleDevices.map(x =>
                            ciphers[x].closeOpenSessionForDevice()));
                    }
                    const resetDevices = e.code === 410 ? e.response.staleDevices : e.response.missingDevices;
                    await this.getKeysForAddr(addr, resetDevices);
                    await this.reloadDevicesAndSend(addr, /*recurse*/ (e.code === 409));
                } else if (e.code === 401 || e.code === 403) {
                    throw e;
                } else {
                    this.emitError(addr, "Failed to send message", e);
                    return;
                }
            }
            this.emitSent(addr);
        }

        async encryptToDevice(address, plaintext, sessionCipher) {
            const ciphertext = await sessionCipher.encrypt(plaintext);
            return this.toJSON(address, ciphertext);
        }

        toJSON(address, encryptedMsg) {
            return {
                type: encryptedMsg.type,
                destinationDeviceId: address.getDeviceId(),
                destinationRegistrationId: encryptedMsg.registrationId,
                content: btoa(encryptedMsg.body)
            };
        }

        async getStaleDeviceIdsForAddr(addr) {
            const deviceIds = await ns.store.getDeviceIds(addr);
            if (!deviceIds.length) {
                return [];  // The server will fill us in with a 409.
            }
            const updateDevices = [];
            for (const id of deviceIds) {
                const address = new libsignal.SignalProtocolAddress(addr, id);
                const sessionCipher = new libsignal.SessionCipher(ns.store, address);
                if (!(await sessionCipher.hasOpenSession())) {
                    updateDevices.push(id);
                }
            }
            return updateDevices;
        }

        async removeDeviceIdsForAddr(addr, deviceIdsToRemove) {
            for (const id of deviceIdsToRemove) {
                const encodedAddr = addr + "." + id;
                await ns.store.removeSession(encodedAddr);
            }
        }

        async sendToAddr(addr) {
            let updateDevices;
            try {
                updateDevices = await this.getStaleDeviceIdsForAddr(addr);
            } catch(e) {
                this.emitError(addr, "Failed to get device ids for address " + addr, e);
                throw e;
            }
            try {
                await this.getKeysForAddr(addr, updateDevices);
            } catch(e) {
                this.emitError(addr, "Failed to retrieve new device keys for address " + addr, e);
                throw e;
            }
            try {
                await this.reloadDevicesAndSend(addr, /*recurse*/ true);
            } catch(e) {
                this.emitError(addr, "Failed to send to address " + addr, e);
                throw e;
            }
        }
    };
})();