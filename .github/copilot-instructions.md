# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

## Adapter-Specific Context
- **Adapter Name**: ioBroker.yamaha
- **Primary Function**: Integration with Yamaha AV receivers (RX-V series and others)
- **Target Devices**: Yamaha Audio/Video receivers with network connectivity
- **Key Dependencies**: yamaha-nodejs-soef, peer-ssdp, request
- **Configuration Requirements**: IP address configuration, realtime updates support
- **Unique Features**: 
  - Real-time state monitoring
  - Sound program management
  - Input switching and configuration
  - Volume and power control
  - Discovery via SSDP (peer-ssdp)
  - HTTP-based communication with receiver devices

This adapter connects ioBroker to Yamaha AV receivers, allowing users to control their audio systems and monitor receiver status through the ioBroker platform. It supports various Yamaha receiver models and provides comprehensive control over receiver functions.

## Core Concepts

### ioBroker Adapter Architecture
ioBroker adapters follow a specific lifecycle and architecture:

```javascript
// Main adapter class extending from @iobroker/adapter-core
class YamahaAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'yamaha' });
    }

    async onReady() {
        // Adapter initialization
    }

    onStateChange(id, state) {
        // Handle state changes
    }

    onUnload(callback) {
        // Cleanup resources
        callback();
    }
}
```

### ioBroker Object Structure
Objects in ioBroker have a hierarchical structure:
- States: `adapter.instance.device.channel.state`
- Example: `yamaha.0.SystemConfig.version`

### State Management
States should be created with proper metadata:
```javascript
await this.setObjectNotExists('device.state', {
    type: 'state',
    common: {
        name: 'State Name',
        type: 'boolean',
        role: 'indicator',
        read: true,
        write: true
    },
    native: {}
});
```

## Development Guidelines

### Logging Best Practices
Use appropriate logging levels:
- `this.log.error()` - For errors that prevent functionality
- `this.log.warn()` - For warnings and recoverable issues  
- `this.log.info()` - For important information
- `this.log.debug()` - For detailed debugging information

### Error Handling
Always implement proper error handling:
```javascript
try {
    // Risky operation
} catch (error) {
    this.log.error(`Operation failed: ${error.message}`);
    // Handle gracefully
}
```

### Resource Cleanup
Always clean up resources in the `unload()` method:
```javascript
onUnload(callback) {
    try {
        // Clear timeouts
        if (this.timeout) clearTimeout(this.timeout);
        // Close connections
        if (this.connection) this.connection.close();
        callback();
    } catch (e) {
        callback();
    }
}
```

### State Updates
Update states efficiently and only when values change:
```javascript
if (value !== this.lastValue) {
    await this.setState('device.state', value, true);
    this.lastValue = value;
}
```

## Yamaha Adapter Specifics

### Network Communication
- Uses HTTP requests to communicate with Yamaha receivers
- Implements timeout handling for network operations
- Supports real-time monitoring with configurable intervals

### Device Discovery
- Utilizes SSDP for automatic device discovery (peer-ssdp)
- Supports manual IP configuration
- Handles network connectivity issues gracefully

### State Structure
The adapter creates states for:
- System configuration (model, version, features)
- Power control and status
- Input selection and available inputs
- Volume control and mute status
- Sound program selection
- Zone control for multi-zone receivers

### Configuration Management
- IP address configuration (required)
- Realtime monitoring toggle
- Update interval settings
- Network timeout configuration

## Testing

### Unit Testing
- Use Jest/Mocha as the primary testing framework
- Test adapter lifecycle methods
- Mock external dependencies (HTTP requests, SSDP)
- Test error scenarios and edge cases

### Integration Testing
- Test with actual Yamaha receiver when possible
- Verify network communication
- Test state updates and synchronization
- Validate configuration options

## Common Patterns

### Async/Await Usage
Prefer async/await over promises for better readability:
```javascript
async onReady() {
    try {
        await this.initializeConnection();
        await this.loadConfiguration();
        this.startMonitoring();
    } catch (error) {
        this.log.error(`Initialization failed: ${error.message}`);
    }
}
```

### Configuration Validation
Always validate configuration:
```javascript
if (!this.config.ip) {
    this.log.error('IP address not configured');
    return;
}
```

### Network Timeout Handling
Implement proper timeout handling for network operations:
```javascript
const timeout = this.config.timeout || 3000;
yamaha = new YAMAHA(this.config.ip, undefined, timeout);
```

## Code Style

### Variable Naming
- Use camelCase for variables and functions
- Use descriptive names that indicate purpose
- Prefix private methods with underscore if needed

### Function Structure
- Keep functions focused and single-purpose
- Use meaningful parameter names
- Return consistent data types

### Comments
- Add JSDoc comments for public methods
- Explain complex logic and business rules
- Document configuration options and their effects

## Dependencies and Libraries

### Core Dependencies
- `@iobroker/adapter-core`: Core adapter functionality
- `yamaha-nodejs-soef`: Yamaha receiver communication library
- `peer-ssdp`: SSDP discovery protocol implementation
- `request`: HTTP request handling (note: deprecated, consider alternatives)

### Development Dependencies
- `@iobroker/testing`: ioBroker-specific testing utilities
- `mocha`: Test framework
- `eslint`: Code linting

## Performance Considerations

### Memory Management
- Clear timeouts and intervals properly
- Avoid memory leaks in event listeners
- Monitor memory usage in long-running operations

### Network Efficiency
- Implement smart polling intervals
- Cache frequently accessed data
- Handle connection pooling appropriately

### State Update Optimization
- Batch state updates when possible  
- Only update states when values actually change
- Use appropriate state roles and types

## Security Considerations

### Network Security
- Validate all network inputs
- Implement proper error handling for network failures
- Consider IP address validation for configuration

### Data Handling
- Sanitize any user-provided configuration data
- Handle sensitive information appropriately
- Implement proper input validation

This comprehensive guide should help GitHub Copilot provide better suggestions and assistance when working on the ioBroker.yamaha adapter.