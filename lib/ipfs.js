const ipfsd = require('ipfsd-ctl')
const log = require('loglevel')

const KEYSIZE = 4096

// validation
// links can be in hex, base58, base64... probably more, but let's just handle those for now
const LINK_REGEX =
exports.LINK_REGEX = /[0-9a-z+\/=]+/i

// globals
// =
var ipfsNode
var ipfsApi

// exported api
// =

const setup =
exports.setup = function () {
  // get a controller for the local ipfs node
  ipfsd.local((err, _ipfsNode) => {
    if (err) {
      // note the error
      // for now, let's keep the process running without ipfs, if it fails
      console.error('Failed to start IPFS')
      console.error(err)
      return
    }
    ipfsNode = _ipfsNode // save global

    // init and start the daemon
    if (ipfsNode.initialized)
      startDaemon()
    else {
      log.debug('[IPFS] Initializing ~/.ipfs, keysize', KEYSIZE)
      ipfsNode.init({ keySize: KEYSIZE }, (err, res) => {
        if (err) {
          console.error('Failed to initialize IPFS')
          console.error(err)
          return
        }
        startDaemon()
      })
    }
  })
}

const shutdown =
exports.shutdown = function () {
  stopDaemon()
}

const getApi =
exports.getApi = function () {
  return ipfsApi
}

const lookupLink =
exports.lookupLink = function (folderKey, path, cb) {
  if (!ipfsApi) {
    log.warn('[IPFS] IPFS Daemon has not setup yet, aborting lookupLink')
    return cb({ notReady: true })
  }

  log.debug('[IPFS] Looking up', path, 'in', folderKey)
  var pathParts = fixPath(path).split('/')
  descend(folderKey)

  function descend (key) {
    log.debug('[IPFS] Listing...', key)
    ipfsApi.object.links(key, { enc: (typeof key == 'string' ? 'base58' : false) }, (err, links) => {
      if (err) return cb(err)
      
      // lookup the entry
      log.debug('[IPFS] folder listing for', key, links)
      var link = findLink(links, pathParts.shift())
      if (!link)
        return cb({ notFound: true })

      // done?
      if (pathParts.length === 0)
        return cb(null, link)

      // descend!
      descend(link.hash)
    })
  }

  function fixPath (str) {
    if (!str) str = ''
    if (str.charAt(0) == '/') str = str.slice(1)
    return str
  }
}

function findLink (links, path) {
  if (!path || path == '/')          path = 'index.html'
  if (path && path.charAt(0) == '/') path = path.slice(1)
    
  for (var i=0; i < links.length; i++) {
    if (links[i].name == path)
      return links[i]
  }
}

// internal
// =

function startDaemon () {
  log.debug('[IPFS] Starting daemon')
  ipfsNode.startDaemon(function (err, _ipfsApi) {
    if (err) {
      console.error('Error while starting IPFS daemon')
      console.error(err)
      return
    }
    ipfsApi = _ipfsApi
    log.debug('[IPFS] Daemon active')

    // output current version
    ipfsApi.version()
      .then((res) => {
        log.debug('[IPFS] Using version', res.Version)
      })
      .catch((err) => {
        console.error('Error fetching IPFS daemon version')
        console.error(err)
      })
  })
}

function stopDaemon () {
  log.debug('[IPFS] Stopping daemon')
  ipfsNode.stopDaemon((err) => {
    if (err) {
      console.error('Error while stopping IPFS daemon')
      console.error(err)
    } else
      log.debug('[IPFS] Daemon closed')
    ipfsApi = null
  })
}