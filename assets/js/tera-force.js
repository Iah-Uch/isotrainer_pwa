// Module: TeraForce device management
// Direct port from tera-connect-web reference implementation

import { BluetoothUtil } from './bluetooth.js';

const TERA_FORCE_NAME_1 = 'TeraForce';
const TERA_FORCE_NAME_2 = 'Tera Force';

const TERA_FORCE_SERVICE_UUID_LEGACY = '0000fca0-0000-1000-8000-00805f9b34fb';
const TERA_FORCE_CHARACTERISTIC_WRITE_UUID_LEGACY = '0000fca1-0000-1000-8000-00805f9b34fb';
const TERA_FORCE_CHARACTERISTIC_READ_UUID_LEGACY = '0000fca2-0000-1000-8000-00805f9b34fb';

const TERA_FORCE_SERVICE_UUID = 'fc52fca0-55f8-4501-afd1-f32e33e8668d';
const TERA_FORCE_CHARACTERISTIC_WRITE_UUID = 'fc52fca1-55f8-4501-afd1-f32e33e8668d';
const TERA_FORCE_CHARACTERISTIC_READ_UUID = 'fc52fca2-55f8-4501-afd1-f32e33e8668d';

const { disconnect: _disconnect } = BluetoothUtil;

const round = (value, precision = 2) => {
    if ([null, undefined].includes(value)) {
        return undefined;
    }
    const decimalScaler = Math.pow(10, precision || 0);
    const v = Math.round(value * decimalScaler) / decimalScaler;
    return v;
};

export class TeraForce {
    constructor() {
        this._teraForceServiceUuid = undefined;
        this._teraForceCharacteristicWriteUuid = undefined;
        this._teraForceCharacteristicReadUuid = undefined;
        
        this._device = undefined;
        this._server = undefined;
        this._writeCharacteristic = undefined;
        this._readCharacteristic = undefined;

        this._batteryLevel = undefined;
        this._macAddress = undefined;
        this._firmwareVersion = undefined;
        this._hardwareVersion = undefined;

        this._referenceWeight = undefined;
        this._referenceAdcValue = undefined;
        this._zeroAdcValue = undefined;

        this._keepAliveTimer = undefined;

        this._status = TeraForce.STATUS_DISCONNECTED;
        
        this.onStatusChange = undefined;
        this.onDisconnect = undefined;
    }

    static STATUS_DISCONNECTED = 'disconnected';
    static STATUS_WAITING_FOR_SETUP = 'waiting-for-setup';
    static STATUS_WAITING_FOR_CALIBRATION = 'waiting-for-calibration';
    static STATUS_CALIBRATING = 'calibrating';
    static STATUS_READY = 'ready';
    static STATUS_MEASURING = 'measuring';
    static STATUS_MEASURING_GOING_UP = 'measuring-going-up';
    static STATUS_MEASURING_GOING_DOWN = 'measuring-going-down';
    
    static _instance = undefined;

    get batteryLevel() {
        return this._batteryLevel;
    }

    get macAddress() {
        return this._macAddress;
    }

    get firmwareVersion() {
        return this._firmwareVersion;
    }

    get hardwareVersion() {
        return this._hardwareVersion;
    }

    get status() {
        return this._status;
    }

    setStatus(status) {
        this._status = status;
        if (this.onStatusChange) {
            this.onStatusChange(status);
        }
    }

    static getInstance() {
        if (!TeraForce._instance) {
            TeraForce._instance = new TeraForce();
        }
        return TeraForce._instance;
    }

    static resetInstance() {
        TeraForce._instance = undefined;
        BluetoothUtil.flush();
        TeraForce.getInstance();
    }

    async pair() {
        this._device = await BluetoothUtil.getDevice({
            names: [TERA_FORCE_NAME_1, TERA_FORCE_NAME_2],
            services: [TERA_FORCE_SERVICE_UUID, TERA_FORCE_SERVICE_UUID_LEGACY]
        });
        if (!this._device) {
            throw new Error("Dispositivo não encontrado.");
        }
        return {
            connect: this.connect.bind(this)
        };
    }

    async connect(param) {
        param = param || {};
        if (!this._device) {
            await this.pair();
        }
        if (param.onDisconnect) {
            this.onDisconnect = param.onDisconnect;
        }
        
        this._server = await BluetoothUtil.connect({
            reference: this._device,
            onConnectingError: param.onConnectingError
        });

        // Set disconnect handler AFTER successful connection
        this._device.ongattserverdisconnected = () => {
            console.log('Evento gattserverdisconnected disparado');
            if (param.onConnectionLost) {
                try {
                    param.onConnectionLost();
                } catch (error) { }
            }
            this.disconnect();
        };

        // Longer delay to allow device to fully stabilize
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify still connected after delay
        if (!this._server?.connected) {
            throw new Error('Dispositivo desconectou durante inicialização.');
        }

        try {
            this._teraForceServiceUuid = TERA_FORCE_SERVICE_UUID;
            this._teraForceCharacteristicWriteUuid = TERA_FORCE_CHARACTERISTIC_WRITE_UUID;
            this._teraForceCharacteristicReadUuid = TERA_FORCE_CHARACTERISTIC_READ_UUID;
            console.log('Tentando serviço moderno:', this._teraForceServiceUuid);
            await BluetoothUtil.getService(this._server, this._teraForceServiceUuid);
            console.log('Serviço moderno encontrado!');
        } catch (error) {
            console.log('Serviço moderno não encontrado, tentando legado:', error.message);
            
            // Check connection again before retrying
            if (!this._server?.connected) {
                throw new Error('Dispositivo desconectou durante descoberta de serviços.');
            }
            
            this._teraForceServiceUuid = TERA_FORCE_SERVICE_UUID_LEGACY;
            this._teraForceCharacteristicWriteUuid = TERA_FORCE_CHARACTERISTIC_WRITE_UUID_LEGACY;
            this._teraForceCharacteristicReadUuid = TERA_FORCE_CHARACTERISTIC_READ_UUID_LEGACY;
            console.log('Tentando serviço legado:', this._teraForceServiceUuid);
            await BluetoothUtil.getService(this._server, this._teraForceServiceUuid);
            console.log('Serviço legado encontrado!');
        }

        const [
            writeServicePromiseResult,
            readServicePromiseResult
        ] = await Promise.allSettled([
            BluetoothUtil.getService(this._server, this._teraForceServiceUuid),
            BluetoothUtil.getService(this._server, this._teraForceServiceUuid)
        ]);

        let writeService;
        let readService;
        if (writeServicePromiseResult.status === 'fulfilled') {
            writeService = writeServicePromiseResult.value;
        } else {
            writeService = await BluetoothUtil.getService(this._server, this._teraForceServiceUuid);
        }

        if (readServicePromiseResult.status === 'fulfilled') {
            readService = readServicePromiseResult.value;
        } else {
            readService = await BluetoothUtil.getService(this._server, this._teraForceServiceUuid);
        }

        const [
            _batteryLevelPromiseResult,
            _macAddressPromiseResult,
            _firmwareVersionPromiseResult,
            _hardwareVersionPromiseResult,
            writeCharacteristicPromiseResult,
            readCharacteristicPromiseResult
        ] = await Promise.allSettled([
            BluetoothUtil.getBatteryLevel(this._server),
            BluetoothUtil.getMACAddress(this._server),
            BluetoothUtil.getFirmwareVersion(this._server),
            BluetoothUtil.getHardwareVersion(this._server),
            BluetoothUtil.getCharacteristic(writeService, this._teraForceCharacteristicWriteUuid),
            BluetoothUtil.getCharacteristic(readService, this._teraForceCharacteristicReadUuid),
        ]);

        let _batteryLevel;
        let _macAddress;
        let _firmwareVersion;
        let _hardwareVersion;
        let writeCharacteristic;
        let readCharacteristic;
        
        if (_batteryLevelPromiseResult.status === 'fulfilled') {
            _batteryLevel = _batteryLevelPromiseResult.value;
        } else {
            _batteryLevel = await BluetoothUtil.getBatteryLevel(this._server);
        }

        if (_macAddressPromiseResult.status === 'fulfilled') {
            _macAddress = _macAddressPromiseResult.value;
        } else {
            _macAddress = await BluetoothUtil.getMACAddress(this._server);
        }

        if (_firmwareVersionPromiseResult.status === 'fulfilled') {
            _firmwareVersion = _firmwareVersionPromiseResult.value;
        } else {
            _firmwareVersion = await BluetoothUtil.getFirmwareVersion(this._server);
        }

        if (_hardwareVersionPromiseResult.status === 'fulfilled') {
            _hardwareVersion = _hardwareVersionPromiseResult.value;
        } else {
            _hardwareVersion = await BluetoothUtil.getHardwareVersion(this._server);
        }

        if (writeCharacteristicPromiseResult.status === 'fulfilled') {
            writeCharacteristic = writeCharacteristicPromiseResult.value;
        } else {
            writeCharacteristic = await BluetoothUtil.getCharacteristic(writeService, this._teraForceCharacteristicWriteUuid);
        }

        if (readCharacteristicPromiseResult.status === 'fulfilled') {
            readCharacteristic = readCharacteristicPromiseResult.value;
        } else {
            readCharacteristic = await BluetoothUtil.getCharacteristic(readService, this._teraForceCharacteristicReadUuid);
        }

        this._batteryLevel = _batteryLevel;
        this._macAddress = _macAddress;
        this._firmwareVersion = _firmwareVersion;
        this._hardwareVersion = _hardwareVersion;
        this._writeCharacteristic = writeCharacteristic;
        this._readCharacteristic = readCharacteristic;

        this.clearKeepAlive();
        this.keepAlive();
        this.setStatus(TeraForce.STATUS_WAITING_FOR_SETUP);
        
        return {
            batteryLevel: this._batteryLevel,
            macAddress: this._macAddress,
            firmwareVersion: this._firmwareVersion,
            hardwareVersion: this._hardwareVersion,
            setup: this.setup.bind(this)
        };
    }

    async disconnect() {
        if (this._device) {
            this._device.ongattserverdisconnected = undefined;
        }
        this.clearKeepAlive();
        await _disconnect(this._server);
        this._server = undefined;
        this._device = undefined;
        this._readCharacteristic = undefined;
        this._writeCharacteristic = undefined;
        this._macAddress = undefined;
        this._batteryLevel = undefined;
        this._firmwareVersion = undefined;
        this._hardwareVersion = undefined;
        this._zeroAdcValue = undefined;
        this._referenceWeight = undefined;
        this._referenceAdcValue = undefined;
        this._teraForceServiceUuid = undefined;
        this._teraForceCharacteristicWriteUuid = undefined;
        this._teraForceCharacteristicReadUuid = undefined;
        this.setStatus(TeraForce.STATUS_DISCONNECTED);
        if (this.onDisconnect) {
            try {
                this.onDisconnect();
            } catch (error) {
            }
        }
        this.onDisconnect = undefined;
    }

    keepAlive() {
        // ONLY CHANGE FROM REFERENCE: 60 seconds instead of 2.5 minutes
        this._keepAliveTimer = setInterval(async () => {
            try {
                await BluetoothUtil.writeValue(this._writeCharacteristic, new Uint8Array([0x02]));
                console.log("Keep-alive enviado para o dispositivo.");
            } catch (error) {
                console.error(`Erro ao manter conexão: ${error.message}`);
                clearInterval(this._keepAliveTimer);
            }
        }, 60 * 1000); // 60 seconds
    }

    clearKeepAlive() {
        if (this._keepAliveTimer) {
            clearInterval(this._keepAliveTimer);
            this._keepAliveTimer = undefined;
        }
    }

    setup(param) {
        let { referenceWeight, referenceAdcValue } = param || {};
        if (!referenceWeight && !referenceAdcValue) {
            if (this.hardwareVersion.startsWith('1')) {
                referenceWeight = 8.65;
                referenceAdcValue = 235;
                console.log('[TeraForce] Setup: Hardware v1 detectado');
            } else {
                referenceWeight = 45;
                referenceAdcValue = 3800;
                console.log('[TeraForce] Setup: Hardware v2+ detectado');
            }
        }
        this._referenceWeight = referenceWeight;
        this._referenceAdcValue = referenceAdcValue;
        console.log(`[TeraForce] Setup completo: ${referenceWeight} kgf @ ${referenceAdcValue} ADC (HW: ${this.hardwareVersion})`);
        this.setStatus(TeraForce.STATUS_WAITING_FOR_CALIBRATION);
        return {
            startCalibration: this.startCalibration.bind(this)
        };
    }

    async startCalibration() {
        this.setStatus(TeraForce.STATUS_CALIBRATING);
        let values = [];
        
        // Ensure notifications are stopped first (clean slate)
        try {
            await BluetoothUtil.unsubscribe(this._readCharacteristic);
        } catch (err) {
            // Ignore error if not subscribed
        }
        
        // Now subscribe with fresh handler
        await BluetoothUtil.subscribe(this._readCharacteristic, (event) => {
            const characteristic = event.target;
            const rawValues = characteristic.value;
            for (let i = 0; i < rawValues.byteLength; i += 2) {
                const value = rawValues.getInt16(i, false);
                values.push(value);
            }
        });

        await BluetoothUtil.writeValue(this._writeCharacteristic, new Uint8Array([0x01]));

        await new Promise(resolve => setTimeout(resolve, 2000));

        await BluetoothUtil.writeValue(this._writeCharacteristic, new Uint8Array([0x00]));

        console.log(`[TeraForce] Calibração: ${values.length} amostras coletadas`);
        
        if (values.length < 10) {
            throw new Error(`Calibração falhou: apenas ${values.length} amostras coletadas. Necessário mínimo 10 amostras. Verifique a conexão e tente novamente.`);
        }
        
        values = values.sort((a, b) => a - b);
        const tenPercent = Math.floor(values.length / 10);
        const trimmedValues = values.slice(tenPercent, values.length - tenPercent);

        if (trimmedValues.length === 0) {
            throw new Error('Calibração falhou: nenhuma amostra válida após filtragem. Tente novamente.');
        }

        const sum = trimmedValues.reduce((acc, value) => acc + value, 0);
        const average = sum / trimmedValues.length;

        this._zeroAdcValue = round(average, 0);
        
        if (!Number.isFinite(this._zeroAdcValue)) {
            throw new Error('Calibração falhou: valor de zero inválido. Tente novamente.');
        }
        
        console.log(`[TeraForce] Calibração completa: Zero ADC = ${this._zeroAdcValue} (de ${trimmedValues.length} amostras válidas)`);

        this.setStatus(TeraForce.STATUS_READY);

        return {
            zeroAdcValue: this._zeroAdcValue,
            start: this.start.bind(this)
        };
    }

    async startContinuousStreaming(param) {
        this.setStatus(TeraForce.STATUS_MEASURING);
        param = param || {};
        
        const conversionFactor = this._referenceWeight / this._referenceAdcValue;
        
        console.log('Iniciando streaming contínuo, fator de conversão:', conversionFactor, 'zero ADC:', this._zeroAdcValue);
        
        // Ensure notifications are stopped first (clean slate from calibration)
        try {
            await BluetoothUtil.unsubscribe(this._readCharacteristic);
        } catch (err) {
            // Ignore error if not subscribed
        }
        
        let sampleCount = 0;
        await BluetoothUtil.subscribe(this._readCharacteristic, (event) => {
            const characteristic = event.target;
            const rawValues = characteristic.value;
            
            for (let i = 0; i < rawValues.byteLength; i += 2) {
                const rawValue = rawValues.getInt16(i, false);
                const calibrated = rawValue - this._zeroAdcValue;
                let value = calibrated * conversionFactor;
                value = round(value, 2);
                
                // Clamp negative values to 0 - samples below 0 should be treated as 0
                if (value < 0) {
                    value = 0;
                }
                
                // Debug first few samples to verify data flow
                if (sampleCount < 3) {
                    console.log(`[TeraForce] Sample #${sampleCount + 1}: Raw=${rawValue}, Zero=${this._zeroAdcValue}, Calibrated=${calibrated}, Force=${value} kgf`);
                    sampleCount++;
                }
                
                if (param.onValue) {
                    try {
                        param.onValue(value);
                    } catch (error) {
                        console.error('Erro no callback onValue:', error);
                    }
                }
            }
        });

        await BluetoothUtil.writeValue(this._writeCharacteristic, new Uint8Array([0x01]));
        console.log('Comando de início enviado (0x01)');

        return {
            stop: this.stopStreaming.bind(this),
            disconnect: this.disconnect.bind(this)
        };
    }

    async stopStreaming() {
        await BluetoothUtil.writeValue(this._writeCharacteristic, new Uint8Array([0x00]));
        console.log('Comando de parada enviado (0x00)');
        this.setStatus(TeraForce.STATUS_READY);
    }

    async start(param) {
        this.setStatus(TeraForce.STATUS_MEASURING);
        param = param || {};
        let untilDoneResolve;
        const untilDone = new Promise((res) => {
            untilDoneResolve = () => {
                res(true);
            };
        });

        const result = [];
        const conversionFactor = this._referenceWeight / this._referenceAdcValue;
        let lastValuesAvg = 0;
        let counter = 0;
        const MAX_COUNT = 3;
        
        await BluetoothUtil.subscribe(this._readCharacteristic, (event) => {
            const characteristic = event.target;
            const rawValues = characteristic.value;
            const values = [];
            let valuesAvg = 0;
            
            for (let i = 0; i < rawValues.byteLength; i += 2) {
                let value = rawValues.getInt16(i, false) - this._zeroAdcValue;
                value = round(value * conversionFactor);
                valuesAvg += value;
                values.push(value);
                if (param.onValue) {
                    try {
                        param.onValue(value);
                    } catch (error) {
                    }
                }
            }
            
            if (param.onValues) {
                try {
                    param.onValues(values);
                } catch (error) {
                }
            }
            
            valuesAvg /= values.length;
            
            if (this.status === TeraForce.STATUS_MEASURING) {
                if (valuesAvg > 2) {
                    this.setStatus(TeraForce.STATUS_MEASURING_GOING_UP);
                    if (param.onStart) {
                        try {
                            param.onStart();
                        } catch (error) {
                        }
                    }
                }
            } else if (this.status === TeraForce.STATUS_MEASURING_GOING_UP) {
                result.push(...values);
                if (valuesAvg < lastValuesAvg) {
                    if (++counter >= MAX_COUNT) {
                        this.setStatus(TeraForce.STATUS_MEASURING_GOING_DOWN);
                        counter = 0;
                    }
                }
            } else if (this.status === TeraForce.STATUS_MEASURING_GOING_DOWN) {
                result.push(...values);
                if (valuesAvg < 1) {
                    if (++counter >= MAX_COUNT) {
                        this.setStatus(TeraForce.STATUS_READY);
                        counter = 0;
                        untilDoneResolve();
                        if (param.onStop) {
                            try {
                                param.onStop();
                            } catch (error) {
                            }
                        }
                    }
                }
            }
            lastValuesAvg = valuesAvg;
        });

        await BluetoothUtil.writeValue(this._writeCharacteristic, new Uint8Array([0x01]));

        await untilDone;

        await BluetoothUtil.writeValue(this._writeCharacteristic, new Uint8Array([0x00]));

        const maxValues = Math.max(...result);
        const minValues = Math.min(...result);
        const avgValues = result.reduce((acc, value) => acc + value, 0) / result.length;

        return {
            data: result,
            max: maxValues,
            min: minValues,
            avg: avgValues,
            disconnect: this.disconnect.bind(this)
        };
    }

    async firmwareUpdate(firmwareImage) {
        await BluetoothUtil.firmwareUpdate(
            this._server,
            firmwareImage
        );
    }
}

