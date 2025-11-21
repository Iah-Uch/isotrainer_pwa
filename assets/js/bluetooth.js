// Module: Low-level Web Bluetooth utilities
// Based on tera-connect-web reference implementation

const bluetooth = navigator.bluetooth;

export const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
export const BATTERY_CHARACTERISTIC_LEVEL_UUID = '00002a19-0000-1000-8000-00805f9b34fb';

export const DEVICE_INFORMATION_SERVICE_UUID = '0000180a-0000-1000-8000-00805f9b34fb';
export const DEVICE_INFORMATION_CHARACTERISTIC_SYSTEM_ID_UUID = '00002a23-0000-1000-8000-00805f9b34fb';
export const DEVICE_INFORMATION_CHARACTERISTIC_FIRMWARE_REVISION_STRING_UUID = '00002a26-0000-1000-8000-00805f9b34fb';
export const DEVICE_INFORMATION_CHARACTERISTIC_HARDWARE_REVISION_STRING_UUID = '00002a27-0000-1000-8000-00805f9b34fb';

export const FIRMWARE_UPDATE_SERVICE_UUID = 'f000ffc0-0451-4000-b000-000000000000';
export const FIRMWARE_UPDATE_CHARACTERISTIC_IMAGE_IDENTIFY_UUID = 'f000ffc1-0451-4000-b000-000000000000';
export const FIRMWARE_UPDATE_CHARACTERISTIC_IMAGE_TRANSFER_UUID = 'f000ffc2-0451-4000-b000-000000000000';

export class BluetoothUtil {
  /**
   * Flush all existing Bluetooth connections
   */
  static async flush() {
    if (bluetooth?.getDevices) {
      try {
        const devices = await bluetooth.getDevices();
        for (const device of devices) {
          if (device.gatt?.connected) {
            console.log(`Desconectando do dispositivo ${device.name || device.id}...`);
            device.gatt.disconnect();
          }
        }
      } catch (err) {
        console.warn('Erro ao limpar conexões BLE:', err?.message || err);
      }
    }
  }

  /**
   * Check if Bluetooth is available on this platform
   */
  static async isBluetoothAvailable() {
    if (!bluetooth?.requestDevice) {
      throw {
        code: 1,
        message: 'O seu navegador não suporta a API Web Bluetooth. Por favor, utilize um navegador compatível.'
      };
    }
    
    try {
      if (typeof bluetooth.getAvailability === 'function') {
        const available = await bluetooth.getAvailability();
        if (!available) {
          throw {
            code: 2,
            message: 'O seu computador não possui um adaptador Bluetooth ou ele está desativado. Por favor, verifique e tente novamente.'
          };
        }
      }
    } catch (err) {
      if (err.code) throw err;
      // If we can't check availability, we'll still try to proceed
      console.warn('Não foi possível verificar disponibilidade do Bluetooth:', err?.message || err);
    }
    
    return true;
  }

  /**
   * Get a Bluetooth device by name or ID
   */
  static async getDevice({ names, id, services = [] }) {
    await BluetoothUtil.isBluetoothAvailable();

    if (!id && (!names || names.length === 0)) {
      throw new Error('Nenhum nome de dispositivo fornecido para filtragem.');
    }

    let device;

    // Try to find previously paired device by ID
    if (id && bluetooth?.getDevices) {
      console.log(`Procurando dispositivo com ID ${id}...`);
      try {
        const devices = await bluetooth.getDevices();
        device = devices.find(d => d.id === id);
        if (device) {
          console.log(`Dispositivo com ID ${device.id} encontrado.`);
          return device;
        }
        console.log(`Dispositivo com ID ${id} não encontrado.`);
      } catch (err) {
        console.warn('Erro ao buscar dispositivos emparelhados:', err?.message || err);
      }
    }

    // Request new device
    console.log(`Procurando dispositivo com nomes ${names.join(', ')}...`);
    
    const filters = names.map(name => ({ namePrefix: name }));
    const optionalServices = [
      BATTERY_SERVICE_UUID,
      DEVICE_INFORMATION_SERVICE_UUID,
      FIRMWARE_UPDATE_SERVICE_UUID,
      ...services
    ];

    device = await bluetooth.requestDevice({
      filters,
      optionalServices
    });

    if (!device) {
      throw new Error('Nenhum dispositivo encontrado com os filtros especificados.');
    }
    
    console.log(`Dispositivo com ID ${device.id} encontrado.`);
    return device;
  }

  /**
   * Connect to a Bluetooth device
   */
  static async connect({ reference, onDisconnect, onConnectingError }) {
    let device = reference;
    
    if (!device) {
      throw new Error('Dispositivo não encontrado.');
    }

    // Extract device from different reference types
    if ('service' in device) {
      device = device.service.device;
    } else if ('device' in device) {
      device = device.device;
    }

    if (onDisconnect) {
      device.ongattserverdisconnected = onDisconnect;
    }

    let server = device.gatt;

    if (!server) {
      throw new Error('Dispositivo não possui um servidor GATT.');
    }

    // Helper function to connect with timeout
    const _connect = async (gattServer, timeoutMs = 5000) => {
      console.log('Conectando ao dispositivo...');

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Tempo limite de conexão excedido.'));
        }, timeoutMs);

        gattServer.connect()
          .then((result) => {
            clearTimeout(timeout);
            console.log('Conectado ao dispositivo.');
            resolve(result);
          })
          .catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
      });
    };

    // Retry connection up to 5 times
    const maxTries = 5;
    let count = 0;
    while (!server.connected && count < maxTries) {
      try {
        server = await _connect(server);
      } catch (error) {
        console.error(`Erro ao conectar ao dispositivo (tentativa ${count + 1}/${maxTries}): ${error.message}`);
        count++;
      }
    }

    // Handle connection error callback
    let done = server.connected || !onConnectingError;
    let doneFn = () => {};
    
    const donePromise = new Promise((resolve) => {
      doneFn = () => {
        done = true;
        resolve(done);
      };
      
      if (done) {
        console.log('Conexão estabelecida com sucesso.');
        doneFn();
      } else {
        // Give user 60 seconds to resolve connection issue
        setTimeout(() => {
          doneFn();
        }, 60000);
        
        try {
          onConnectingError(doneFn);
        } catch (error) {
          console.error('Erro no callback de erro de conexão:', error);
        }
      }
    });

    await donePromise;

    if (!server.connected) {
      throw new Error('Erro ao conectar ao dispositivo.');
    }

    return server;
  }

  /**
   * Disconnect from a Bluetooth device
   */
  static async disconnect(server) {
    if (server?.connected) {
      try {
        console.log('Desconectando do dispositivo...');
        server.disconnect();
        
        // Wait for disconnect to complete
        let count = 0;
        while (server.connected && count < 10) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          count++;
        }
        
        console.log('Desconectado do dispositivo.');
      } catch (error) {
        console.error(`Erro ao desconectar do dispositivo: ${error.message}`);
      } finally {
        await BluetoothUtil.flush();
      }
    }
  }

  /**
   * Get a service from a GATT server
   */
  static async getService(server, serviceUuid) {
    if (!server?.connected) {
      throw new Error('Servidor GATT não está conectado.');
    }
    console.log(`Obtendo serviço ${serviceUuid}...`);
    const result = await server.getPrimaryService(serviceUuid);
    console.log(`Serviço ${serviceUuid} obtido.`);
    return result;
  }

  /**
   * Get a characteristic from a service
   */
  static async getCharacteristic(service, characteristicUuid) {
    if (!service?.device?.gatt?.connected) {
      throw new Error('Dispositivo não está conectado.');
    }
    console.log(`Obtendo característica ${characteristicUuid}...`);
    const result = await service.getCharacteristic(characteristicUuid);
    console.log(`Característica ${characteristicUuid} obtida.`);
    return result;
  }

  /**
   * Read a value from a characteristic
   */
  static async readValue(characteristic) {
    if (!characteristic?.service?.device?.gatt?.connected) {
      throw new Error('Dispositivo não está conectado.');
    }
    console.log('Lendo valor da característica...');
    const result = await characteristic.readValue();
    console.log('Valor da característica lido.');
    return result;
  }

  /**
   * Write a value to a characteristic
   */
  static async writeValue(characteristic, value) {
    if (!characteristic?.service?.device?.gatt?.connected) {
      throw new Error('Dispositivo não está conectado.');
    }
    console.log('Escrevendo valor na característica...');
    await characteristic.writeValue(value);
    console.log('Valor escrito na característica.');
  }

  /**
   * Subscribe to notifications from a characteristic
   */
  static async subscribe(characteristic, callback) {
    if (!characteristic.properties.notify) {
      throw new Error('Esta característica não suporta notificações.');
    }
    
    if (!characteristic?.service?.device?.gatt?.connected) {
      throw new Error('Dispositivo não está conectado.');
    }
    
    console.log('Iniciando subscrição na característica...');
    characteristic.oncharacteristicvaluechanged = callback;
    const result = await characteristic.startNotifications();
    console.log('Subscrição na característica iniciada.');
    return result;
  }

  /**
   * Unsubscribe from notifications
   */
  static async unsubscribe(characteristic) {
    if (!characteristic.properties.notify) {
      throw new Error('Esta característica não suporta notificações.');
    }
    
    if (!characteristic?.service?.device?.gatt?.connected) {
      throw new Error('Dispositivo não está conectado.');
    }
    
    console.log('Parando subscrição na característica...');
    characteristic.oncharacteristicvaluechanged = null;
    const result = await characteristic.stopNotifications();
    console.log('Subscrição na característica parada.');
    return result;
  }

  /**
   * Get battery level from device
   */
  static async getBatteryLevel(server) {
    try {
      const batteryService = await BluetoothUtil.getService(server, BATTERY_SERVICE_UUID);
      const batteryLevelCharacteristic = await BluetoothUtil.getCharacteristic(
        batteryService,
        BATTERY_CHARACTERISTIC_LEVEL_UUID
      );
      const value = await BluetoothUtil.readValue(batteryLevelCharacteristic);
      return value.getUint8(0);
    } catch (err) {
      console.warn('Não foi possível obter nível de bateria:', err?.message || err);
      return null;
    }
  }

  /**
   * Get MAC address from device
   */
  static async getMACAddress(server) {
    try {
      const deviceInformationService = await BluetoothUtil.getService(
        server,
        DEVICE_INFORMATION_SERVICE_UUID
      );
      const systemIdCharacteristic = await BluetoothUtil.getCharacteristic(
        deviceInformationService,
        DEVICE_INFORMATION_CHARACTERISTIC_SYSTEM_ID_UUID
      );
      const systemIdValue = await BluetoothUtil.readValue(systemIdCharacteristic);
      
      const macAddress = 
        systemIdValue.getUint8(7).toString(16).padStart(2, '0') + ':' +
        systemIdValue.getUint8(6).toString(16).padStart(2, '0') + ':' +
        systemIdValue.getUint8(5).toString(16).padStart(2, '0') + ':' +
        systemIdValue.getUint8(2).toString(16).padStart(2, '0') + ':' +
        systemIdValue.getUint8(1).toString(16).padStart(2, '0') + ':' +
        systemIdValue.getUint8(0).toString(16).padStart(2, '0');
      
      return macAddress.toUpperCase();
    } catch (err) {
      console.warn('Não foi possível obter endereço MAC:', err?.message || err);
      return null;
    }
  }

  /**
   * Get firmware version from device
   */
  static async getFirmwareVersion(server) {
    const maxRetries = 3;
    const retryDelay = 200; // ms
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Tentativa ${attempt + 1} de ${maxRetries} para obter versão do firmware...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
        
        const deviceInformationService = await BluetoothUtil.getService(
          server,
          DEVICE_INFORMATION_SERVICE_UUID
        );
        const firmwareRevisionStringCharacteristic = await BluetoothUtil.getCharacteristic(
          deviceInformationService,
          DEVICE_INFORMATION_CHARACTERISTIC_FIRMWARE_REVISION_STRING_UUID
        );
        
        // Small delay before reading to ensure characteristic is ready
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const firmwareRevisionStringValue = await BluetoothUtil.readValue(
          firmwareRevisionStringCharacteristic
        );
        
        // Handle DataView properly - extract bytes accounting for byteOffset and byteLength
        let bytes;
        if (firmwareRevisionStringValue instanceof DataView) {
          bytes = new Uint8Array(
            firmwareRevisionStringValue.buffer,
            firmwareRevisionStringValue.byteOffset,
            firmwareRevisionStringValue.byteLength
          );
        } else if (firmwareRevisionStringValue.buffer) {
          bytes = new Uint8Array(firmwareRevisionStringValue.buffer);
        } else {
          bytes = new Uint8Array(firmwareRevisionStringValue);
        }
        
        // Convert bytes to string, removing null bytes and control characters
        let result = '';
        for (let i = 0; i < bytes.length; i++) {
          const byte = bytes[i];
          // Skip null bytes and control characters (except space and printable chars)
          if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
            continue;
          }
          // Only include printable ASCII or valid UTF-8 continuation
          if (byte >= 32 && byte <= 126) {
            result += String.fromCharCode(byte);
          }
        }
        
        result = result.trim();
        
        // Extract only numeric characters (version number)
        const numericMatch = result.match(/\d+/);
        if (numericMatch) {
          result = numericMatch[0];
        } else if (result === '' || isNaN(Number(result))) {
          console.warn('Firmware version parsing failed, raw bytes:', Array.from(bytes).map(b => b.toString(16)).join(' '), 'decoded:', JSON.stringify(result));
          result = '1';
        }
        
        const debugInfo = {
          rawBytes: Array.from(bytes).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
          decodedString: result,
          byteLength: bytes.length
        };
        console.log('Firmware version parsed:', result, 'from bytes:', debugInfo.rawBytes);
        
        // Store debug info for mobile debugging
        if (typeof window !== 'undefined' && window.state) {
          window.state.firmwareDebug = debugInfo;
        }
        
        return result;
      } catch (err) {
        const isLastAttempt = attempt === maxRetries - 1;
        if (isLastAttempt) {
          console.warn('Não foi possível obter versão do firmware após', maxRetries, 'tentativas:', err?.message || err);
          // Store error for debugging
          if (typeof window !== 'undefined' && window.state) {
            window.state.firmwareDebug = {
              error: err?.message || String(err),
              attempts: maxRetries
            };
          }
          return '1'; // Default to version 1
        }
        // Retry on next iteration
        console.warn(`Tentativa ${attempt + 1} falhou, tentando novamente...`, err?.message || err);
      }
    }
    return '1'; // Fallback (should not reach here)
  }

  /**
   * Get hardware version from device
   */
  static async getHardwareVersion(server) {
    const maxRetries = 3;
    const retryDelay = 200; // ms
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`Tentativa ${attempt + 1} de ${maxRetries} para obter versão do hardware...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
        
        const deviceInformationService = await BluetoothUtil.getService(
          server,
          DEVICE_INFORMATION_SERVICE_UUID
        );
        const hardwareRevisionStringCharacteristic = await BluetoothUtil.getCharacteristic(
          deviceInformationService,
          DEVICE_INFORMATION_CHARACTERISTIC_HARDWARE_REVISION_STRING_UUID
        );
        
        // Small delay before reading to ensure characteristic is ready
        await new Promise(resolve => setTimeout(resolve, 50));
        
        const hardwareRevisionStringValue = await BluetoothUtil.readValue(
          hardwareRevisionStringCharacteristic
        );
        
        // Handle DataView properly - extract bytes accounting for byteOffset and byteLength
        let bytes;
        if (hardwareRevisionStringValue instanceof DataView) {
          bytes = new Uint8Array(
            hardwareRevisionStringValue.buffer,
            hardwareRevisionStringValue.byteOffset,
            hardwareRevisionStringValue.byteLength
          );
        } else if (hardwareRevisionStringValue.buffer) {
          bytes = new Uint8Array(hardwareRevisionStringValue.buffer);
        } else {
          bytes = new Uint8Array(hardwareRevisionStringValue);
        }
        
        // Convert bytes to string, removing null bytes and control characters
        let result = '';
        for (let i = 0; i < bytes.length; i++) {
          const byte = bytes[i];
          // Skip null bytes and control characters (except space and printable chars)
          if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
            continue;
          }
          // Only include printable ASCII or valid UTF-8 continuation
          if (byte >= 32 && byte <= 126) {
            result += String.fromCharCode(byte);
          }
        }
        
        result = result.trim();
        
        // Extract only numeric characters (version number)
        const numericMatch = result.match(/\d+/);
        if (numericMatch) {
          result = numericMatch[0];
        } else if (result === '' || isNaN(Number(result))) {
          console.warn('Hardware version parsing failed, raw bytes:', Array.from(bytes).map(b => b.toString(16)).join(' '), 'decoded:', JSON.stringify(result));
          result = '1';
        }
        
        const debugInfo = {
          rawBytes: Array.from(bytes).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
          decodedString: result,
          byteLength: bytes.length
        };
        console.log('Hardware version parsed:', result, 'from bytes:', debugInfo.rawBytes);
        
        // Store debug info for mobile debugging
        if (typeof window !== 'undefined' && window.state) {
          window.state.hardwareDebug = debugInfo;
        }
        
        return result;
      } catch (err) {
        const isLastAttempt = attempt === maxRetries - 1;
        if (isLastAttempt) {
          console.warn('Não foi possível obter versão do hardware após', maxRetries, 'tentativas:', err?.message || err);
          // Store error for debugging
          if (typeof window !== 'undefined' && window.state) {
            window.state.hardwareDebug = {
              error: err?.message || String(err),
              attempts: maxRetries
            };
          }
          return '1'; // Default to version 1
        }
        // Retry on next iteration
        console.warn(`Tentativa ${attempt + 1} falhou, tentando novamente...`, err?.message || err);
      }
    }
    return '1'; // Fallback (should not reach here)
  }
}

