const { app } = require('electron')
const log = require('loglevel')
const path = require('path')
const ipfsNetwork = require('./lib/ipfs')
const ipfsProtocol = require('./protocols/ipfs')

// exported api
// =

module.exports = {
  configure (opts) {
    if (opts.logLevel)
      log.setLevel(opts.logLevel)
  },
  protocols: [ipfsProtocol]
}

// internal
// =

// register some events to control the network lifecycle
app.on('ready', () => ipfsNetwork.setup(path.join(app.getPath('userData'), 'IPFS')))
app.once('will-quit', () => ipfsNetwork.shutdown())

// plug the logger to support spread args
var originalFactory = log.methodFactory
log.methodFactory = function (methodName, logLevel, loggerName) {
  var rawMethod = originalFactory(methodName, logLevel, loggerName)
  return (...message) => rawMethod(message.map(stringifyIfNeeded).join(' '))
}
function stringifyIfNeeded (obj) {
  if (obj && typeof obj == 'object')
    return JSON.stringify(obj)
  return obj
}
log.setLevel('trace')