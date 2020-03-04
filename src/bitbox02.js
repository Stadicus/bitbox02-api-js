import './bitbox02-api-go.js';

import { getKeypathFromString, getCoinFromKeypath } from './eth-utils.js';

export const api = bitbox02;
export const firmwareAPI = api.firmware;
export const HARDENED = 0x80000000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Will try for 1 second to find a device through the bridge.
export async function getDevicePath() {
    const attempts = 10;
    for (let i=0; i<attempts; i++){
        let response;
        try {
            response = await fetch("http://localhost:8178/api/v1/devices", {
                method: 'GET',
                headers: {},
            });
        } catch {
            throw new Error('BitBoxBridge not found');
        }
        const devices = (await response.json()).devices;
        if (devices.length !== 1) {
            await sleep(100);
            continue;
        }
        const devicePath = devices[0].path;
        return devicePath;
    }
    throw new Error("Expected one BitBox02");
}

function promisify(f) {
    return function(...args) {
        return new Promise((resolve, reject) => f(
            (...results) => {
                const err = results.pop();
                if (err !== null) {
                    return reject(err);
                }
                return resolve(...results);
            },
            ...args));
    };
}

export class BitBox02API {
    constructor(devicePath)  {
        this.devicePath = devicePath;
        this.opened = false;
    }

    /**
     * @param showPairingCb Callback that is used to show pairing code. Must not block.
     * @param userVerify Promise that should resolve once the user wants to continue.
     * @param handleAttastionCb Callback that should handle the bool attestation result. Must not block.
     * @param onCloseCb Callback that's called when the websocket connection is closed.
     * @param setStatusCb Callback that lets the API set the status received from the device.
     * @return Promise that will resolve once the pairing is complete.
     */
    connect (showPairingCb, userVerify, handleAttestationCb, onCloseCb, setStatusCb) {
        const self = this;
        self.opened = true;
        return new Promise((resolve, reject) => {
            function onWrite(bytes) {
                if (self.socket.readyState != WebSocket.OPEN) {
                    console.log("Error, trying to write to closed socket");
                    return;
                }
                self.socket.send(bytes);
            }

            self.socket = new WebSocket("ws://127.0.0.1:8178/api/v1/socket/" + self.devicePath)
            self.socket.binaryType = 'arraybuffer'
            self.socket.onopen = async function (event) {
                try {
                    self.fw = firmwareAPI.New(onWrite);

                    // Turn all Async* methods into promises.
                    for (const key in self.firmware().js) {
                        if (key.startsWith("Async")) {
                            self.firmware().js[key] = promisify(self.firmware().js[key]);
                        }
                    }

                    self.firmware().SetOnEvent(ev => {
                        if (ev === firmwareAPI.Event.StatusChanged && self.firmware()) {
                            setStatusCb(self.firmware().Status());
                        }
                        if (ev === firmwareAPI.Event.StatusChanged && self.firmware().Status() === firmwareAPI.Status.Unpaired) {
                            const [channelHash] = self.firmware().ChannelHash();
                            showPairingCb(channelHash);
                        }
                        if (ev === firmwareAPI.Event.AttestationCheckDone) {
                            handleAttestationCb(self.firmware().Attestation());
                        }
                        if (ev === firmwareAPI.Event.StatusChanged && self.firmware().Status() === firmwareAPI.Status.RequireFirmwareUpgrade) {
                            self.socket.close();
                            reject('Firmware upgrade required');
                        }
                        if (ev === firmwareAPI.Event.StatusChanged && self.firmware().Status() === firmwareAPI.Status.RequireAppUpgrade) {
                            self.socket.close();
                            reject('Unsupported firmware');
                        }
                        if (ev === firmwareAPI.Event.StatusChanged && self.firmware().Status() === firmwareAPI.Status.Uninitialized) {
                            self.socket.close();
                            reject('Uninitialized');
                        }
                    });

                    await self.firmware().js.AsyncInit();
                    switch(self.firmware().Status()) {
                        case firmwareAPI.Status.PairingFailed:
                            self.socket.close();
                            throw new Error("Pairing rejected");
                        case firmwareAPI.Status.Unpaired:
                            await userVerify()
                            await self.firmware().js.AsyncChannelHashVerify(true);
                            break;
                        case firmwareAPI.Status.Initialized:
                            // Pairing skipped.
                            break;
                        default:
                            throw new Error("Unexpected status: " + self.firmware().Status() + "," + firmwareAPI.Status.Unpaired);
                    }

                    resolve();
                } catch(err) {
                    reject(err);
                }
            }
            self.socket.onerror = function(event) {
                reject("Your BitBox02 is busy");
            }
            self.socket.onmessage = function(event) {
                self.firmware().js.OnRead(new Uint8Array(event.data));
            }
            self.socket.onclose = function(event) {
                onCloseCb();
            }
        });
    }

    /**
     * @param keypath account keypath in string format
     * Currently only two keypaths are supported:
     * - `m/44'/60'/0'/0` for mainnet and
     * - `m/44'/1'/0'/0`  for Rinkeby and Ropsten testnets
     * @returns string; ethereum extended public key
     */
    async ethGetRootPubKey(keypath) {
        const keypathArray = getKeypathFromString(keypath);
        const coin = getCoinFromKeypath(keypathArray);
        const xpub = await this.firmware().js.AsyncETHPub(
            coin,
            keypathArray,
            firmwareAPI.messages.ETHPubRequest_OutputType.XPUB,
            false,
            new Uint8Array()
          );
        return xpub
    };

    /**
     * @param keypath string, e.g. m/44'/60'/0'/0/0 for the first mainnet account
     * Displays the address of the provided ethereum account on device screen
     * Only displays address on device, does not return. For verification, derive address from xpub
     */
    async ethDisplayAddress(keypath) {
        const keypathArray = getKeypathFromString(keypath);
        // FIXME: see def of `getCoinFromPath()`, since we use the same keypath for Ropsten and Rinkeby,
        // the title for Rinkeby addresses will show 'Ropsten' instead
        const coin = getCoinFromKeypath(keypathArray);
        this.firmware().js.AsyncETHPub(
            coin,
            keypathArray,
            firmwareAPI.messages.ETHPubRequest_OutputType.ADDRESS,
            true,
            new Uint8Array()
          );
    };

    /**
     * Signs an ethereum transaction on device
     * @param sanitizedData Object returned by `sanitizeEthTransactionData`
     * @returns Object; result with the signature bytes r, s, v
     * result = {
     *     r: Uint8Array(32)
     *     s: Uint8Array(32)
     *     v: Uint8Array(1)
     * }
     */
    async ethSignTransaction(sigData) {
        try {
            const sig = await this.firmware().js.AsyncETHSign(
                sigData.coin,
                sigData.keypath,
                sigData.nonce,
                sigData.gasPrice,
                sigData.gasLimit,
                sigData.recipient,
                sigData.value,
                sigData.data
            );
            const chainId = sigData.chainId;
            const vOffset = chainId * 2 + 8;
            const result = {
                r: sig.slice(0, 0 + 32),
                s: sig.slice(0 + 32, 0 + 32 + 32),
                v: [parseInt(sig.slice(64), 16) + 27 + vOffset]
            };
            return result;
        } catch (err) {
                if (firmwareAPI.IsErrorAbort(err)) {
                throw new Error('User abort');
            } else {
                throw new Error(err.Message);
            }
        }
    };

    /** @param msgData is an object including the keypath and the message as bytes:
     *
     * const msgData = {
     *     keypath    // string, e.g. m/44'/60'/0'/0/0 for the first mainnet account
     *     message    // Buffer/Uint8Array
     * }
     *
     * @returns Object; result with the signature bytes r, s, v
     * result = {
     *     r: Uint8Array(32)
     *     s: Uint8Array(32)
     *     v: Uint8Array(1)
     * }
     */
    async ethSignMessage(msgData) {
        try {
            const keypath = getKeypathFromString(msgData.keypath);
            const sig = await this.firmware().js.AsyncETHSignMessage(
                getCoinFromKeypath(keypath),
                keypath,
                msgData.message
          );

            const result = {
                r: sig.slice(0, 0 + 32),
                s: sig.slice(0 + 32, 0 + 32 + 32),
                v: [parseInt(sig.slice(64), 16) + 27]
          };
          return result;
        } catch(err) {
          if (firmwareAPI.IsErrorAbort(err)) {
              throw new Error('User abort');
          } else {
              throw new Error(err.Message);
          }
        }
    }

    /**
     * @returns True if the connection has been opened and successfully established.
     */
    connectionValid() {
        return this.opened && this.socket.readyState == WebSocket.OPEN;
    }

    /**
     * @returns False if connection wasn't opened
     */
    close() {
        if (!this.connectionValid()) {
            return false;
        }
        this.socket.close();
        return true;
    }

    /**
     * Use the return value of this function to communicate with device
     * @return Undefined if connection wasn't opened
     */
    firmware() {
        if (!this.connectionValid()) {
            throw new Error('Device or websocket not connected')
        }
        return this.fw;
    }
}
