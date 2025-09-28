# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

[CUSTOMIZE: This adapter controls Yamaha AV-Receivers via network HTTP XML API. It connects to Yamaha receivers on the local network (RX-V series and similar models) using HTTP requests with XML payloads. The adapter uses SSDP (peer-ssdp library) for device discovery and maintains real-time connections for status updates. It supports multi-zone audio systems, surround sound configuration, input switching, volume control, and various Yamaha-specific features like YPAO (Yamaha Parametric Acoustic Optimizer), Party Mode, and Pure Direct mode. The adapter requires "network standby" to be enabled on the receiver to function properly.]

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties
                        Object.assign(obj.native, {
                            position: TEST_COORDINATES,
                            createCurrently: true,
                            createHourly: true,
                            createDaily: true,
                            // Add other configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Check for specific states
                        const states = await harness.states.getKeysAsync('your-adapter.0.*');
                        console.log(`📊 Created states: ${states.length}`);

                        if (states.length === 0) {
                            throw new Error('❌ No states created - possible configuration or API issue');
                        }

                        console.log('✅ Integration test successful');
                        resolve(states);
                    } catch (error) {
                        console.error('❌ Integration test failed:', error.message);
                        reject(error);
                    }
                });
            }).timeout(60000);
        });
    }
});
```

[CUSTOMIZE: For Yamaha adapter testing, include mock HTTP XML responses for typical receiver status calls. Test scenarios should include: XML command parsing, zone control, volume adjustments, input switching, realtime status updates, SSDP device discovery, and error handling for network timeouts. Since Yamaha receivers only allow one simultaneous connection, tests should verify proper connection management and cleanup.]

### Advanced Testing Patterns

#### State Testing
When testing state creation and updates:
```javascript
it('should create and update states correctly', async () => {
  // Test state creation
  await harness.states.setStateAsync('test.state', { val: 'test', ack: true });
  
  // Verify state was created
  const state = await harness.states.getStateAsync('test.state');
  expect(state).toBeTruthy();
  expect(state.val).toBe('test');
});
```

#### Event Testing
Test adapter event handling:
```javascript
it('should handle state changes', async () => {
  let changeDetected = false;
  
  // Subscribe to state changes
  harness.states.on('stateChange', (id, state) => {
    if (id.includes('your-adapter') && state && !state.ack) {
      changeDetected = true;
    }
  });
  
  // Trigger state change
  await harness.states.setStateAsync('your-adapter.0.test', { val: 'new', ack: false });
  
  // Wait and verify
  await wait(1000);
  expect(changeDetected).toBe(true);
});
```

#### Configuration Testing
Test different adapter configurations:
```javascript
describe('Configuration variants', () => {
  const configurations = [
    { name: 'minimal', config: { enabled: true } },
    { name: 'advanced', config: { enabled: true, advanced: true, interval: 30 } }
  ];
  
  configurations.forEach(({ name, config }) => {
    it(`should work with ${name} configuration`, async () => {
      await harness.changeAdapterConfig('your-adapter', { native: config });
      await harness.startAdapter();
      // Test specific functionality
    });
  });
});
```

## ioBroker Integration

### Adapter Lifecycle
Follow the standard ioBroker adapter lifecycle:
```javascript
class YourAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: 'your-adapter' });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    // Initialize adapter
    this.setState('info.connection', false, true);
    
    // Set up state subscriptions
    this.subscribeStates('*');
    
    // Start main functionality
    await this.main();
  }

  onStateChange(id, state) {
    if (!state || state.ack) return;
    
    this.log.debug(`State ${id} changed: ${state.val}`);
    // Handle state changes
  }

  onUnload(callback) {
    try {
      // Clean up resources
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = null;
      }
      
      // Close connections
      if (this.connection) {
        this.connection.close();
        this.connection = null;
      }
      
      this.setState('info.connection', false, true);
      callback();
    } catch (error) {
      callback();
    }
  }
}
```

[CUSTOMIZE: For Yamaha adapter, ensure proper cleanup of HTTP connections, SSDP discovery processes, and realtime monitoring intervals. Handle network errors gracefully and implement reconnection logic for lost connections to the receiver.]

### State Management

#### State Creation Patterns
```javascript
// Standard state creation
await this.setObjectNotExistsAsync('device.channel.state', {
    type: 'state',
    common: {
        name: 'State Name',
        type: 'boolean|number|string',
        role: 'indicator|value|button',
        read: true,
        write: false,
        def: false
    },
    native: {}
});

// State with enum values (for dropdowns)
await this.setObjectNotExistsAsync('config.mode', {
    type: 'state',
    common: {
        name: 'Operation Mode',
        type: 'string',
        role: 'value',
        read: true,
        write: true,
        states: {
            'auto': 'Automatic',
            'manual': 'Manual',
            'off': 'Disabled'
        }
    },
    native: {}
});
```

#### State Updates
Always use proper acknowledgment flags:
```javascript
// Incoming data from device (acknowledged)
await this.setState('sensor.temperature', { val: 23.5, ack: true });

// Command to device (not acknowledged initially)
await this.setState('control.power', { val: true, ack: false });
```

### Configuration Management
Use io-package.json native section for configuration:
```javascript
// Access configuration
const config = this.config;
const deviceIp = config.ip;
const interval = config.interval || 60;

// Validate required configuration
if (!config.ip) {
    this.log.error('IP address not configured');
    return;
}
```

[CUSTOMIZE: For Yamaha adapter configuration, validate that the IP address is accessible and that network standby is enabled. Provide helpful error messages for common misconfigurations like firewall blocking or receiver network settings.]

### Error Handling

#### Network Error Patterns
```javascript
try {
    const response = await this.makeRequest(url);
    // Handle success
} catch (error) {
    if (error.code === 'ECONNREFUSED') {
        this.log.error('Connection refused - check if device is online');
    } else if (error.code === 'ETIMEDOUT') {
        this.log.warn('Request timeout - device may be slow to respond');
    } else if (error.code === 'ENOTFOUND') {
        this.log.error('Device not found - check IP address');
    } else {
        this.log.error(`Network error: ${error.message}`);
    }
    
    this.setState('info.connection', false, true);
}
```

#### Graceful Degradation
```javascript
async function fetchDeviceStatus() {
    try {
        const status = await this.getDeviceStatus();
        this.setState('info.connection', true, true);
        return status;
    } catch (error) {
        this.log.debug(`Status fetch failed: ${error.message}`);
        this.setState('info.connection', false, true);
        
        // Continue with cached data or default values
        return this.lastKnownStatus || {};
    }
}
```

### Logging Best Practices
Use appropriate log levels:
```javascript
// For regular operation info
this.log.info('Adapter started successfully');

// For debugging (only in debug mode)
this.log.debug(`Processing data: ${JSON.stringify(data)}`);

// For warnings that don't stop operation
this.log.warn('Device response delayed, retrying...');

// For errors that affect functionality
this.log.error(`Failed to connect to device: ${error.message}`);
```

### Performance Optimization

#### Efficient State Updates
```javascript
// Batch state updates when possible
const updates = {};
updates['device.temperature'] = { val: data.temp, ack: true };
updates['device.humidity'] = { val: data.humidity, ack: true };
updates['device.pressure'] = { val: data.pressure, ack: true };

// Apply all updates
for (const [id, state] of Object.entries(updates)) {
    await this.setState(id, state);
}
```

#### Memory Management
```javascript
// Clear intervals and timeouts
onUnload(callback) {
  try {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    // Close connections, clean up resources
    callback();
  } catch (e) {
    callback();
  }
}
```

[CUSTOMIZE: For Yamaha receivers, implement efficient polling intervals and avoid unnecessary XML requests. Cache device capabilities and status where possible to reduce network load.]

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

## CI/CD and Testing Integration

### GitHub Actions for API Testing
For adapters with external API dependencies, implement separate CI/CD jobs:

```yaml
# Tests API connectivity with demo credentials (runs separately)
demo-api-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run demo API tests
      run: npm run test:integration-demo
```

### CI/CD Best Practices
- Run credential tests separately from main test suite
- Use ubuntu-22.04 for consistency
- Don't make credential tests required for deployment
- Provide clear failure messages for API connectivity issues
- Use appropriate timeouts for external API calls (120+ seconds)

### Package.json Script Integration
Add dedicated script for credential testing:
```json
{
  "scripts": {
    "test:integration-demo": "mocha test/integration-demo --exit"
  }
}
```

### Practical Example: Complete API Testing Implementation
Here's a complete example based on lessons learned from the Discovergy adapter:

#### test/integration-demo.js
```javascript
const path = require("path");
const { tests } = require("@iobroker/testing");

// Helper function to encrypt password using ioBroker's encryption method
async function encryptPassword(harness, password) {
    const systemConfig = await harness.objects.getObjectAsync("system.config");
    
    if (!systemConfig || !systemConfig.native || !systemConfig.native.secret) {
        throw new Error("Could not retrieve system secret for password encryption");
    }
    
    const secret = systemConfig.native.secret;
    let result = '';
    for (let i = 0; i < password.length; ++i) {
        result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ password.charCodeAt(i));
    }
    
    return result;
}

// Run integration tests with demo credentials
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("API Testing with Demo Credentials", (getHarness) => {
            let harness;
            
            before(() => {
                harness = getHarness();
            });

            it("Should connect to API and initialize with demo credentials", async () => {
                console.log("Setting up demo credentials...");
                
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                
                const encryptedPassword = await encryptPassword(harness, "demo_password");
                
                await harness.changeAdapterConfig("your-adapter", {
                    native: {
                        username: "demo@provider.com",
                        password: encryptedPassword,
                        // other config options
                    }
                });

                console.log("Starting adapter with demo credentials...");
                await harness.startAdapter();
                
                // Wait for API calls and initialization
                await new Promise(resolve => setTimeout(resolve, 60000));
                
                const connectionState = await harness.states.getStateAsync("your-adapter.0.info.connection");
                
                if (connectionState && connectionState.val === true) {
                    console.log("✅ SUCCESS: API connection established");
                    return true;
                } else {
                    throw new Error("API Test Failed: Expected API connection to be established with demo credentials. " +
                        "Check logs above for specific API errors (DNS resolution, 401 Unauthorized, network issues, etc.)");
                }
            }).timeout(120000);
        });
    }
});
```

[CUSTOMIZE: For Yamaha adapter testing, create mock XML responses for device discovery and status calls. Test different receiver models (RX-V series) and multi-zone configurations. Include network error simulation and recovery testing.]