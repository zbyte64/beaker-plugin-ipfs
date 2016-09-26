const createIPFSAPI = require('ipfs-api')
const ipfsd = require('ipfsd-ctl')
const isIPFS = require('is-ipfs')
const log = require('loglevel')
const dns = require('dns')
const path = require('path')
const fs = require('fs')

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

var isAttemptingSetup = false
const setup =
exports.setup = function () {
  if (isAttemptingSetup)
    return
  isAttemptingSetup = true

  // get a controller for the local ipfs node
  ipfsd.local((err, _ipfsNode) => {
    if (err) {
      // note the error
      // for now, let's keep the process running without ipfs, if it fails
      log.error('[IPFS] Failed to setup IPFS')
      log.error(err)
      isAttemptingSetup = false
      return
    }
    ipfsNode = _ipfsNode // save global

    // setup the API
    if (ipfsNode.initialized) {    
      parseConfig(ipfsNode.path, (err, conf) => {  
        if (err) {
          log.error('[IPFS] Error fetching IPFS config:', err)
          isAttemptingSetup = false
          return
        }
        log.debug('[IPFS] Connecting to daemon')
        ipfsApi = createIPFSAPI(conf.Addresses.API)

        // output current version
        ipfsApi.version()
          .then((res) => {
            log.debug('[IPFS] Using version', res.Version)
            isAttemptingSetup = false
          })
          .catch((err) => {
            log.error('[IPFS] Error fetching IPFS daemon version:', err.code || err)
            isAttemptingSetup = false
            shutdown()
          })
      })
    } else {
      log.warn('[IPFS] IPFS Daemon not running at startup. ipfs: protocol disabled.')
      isAttemptingSetup = false
    }
  })
}

const shutdown =
exports.shutdown = function () {
  ipfsApi = ipfsNode = null
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

  // do DNS resolution if needed
  if (folderKey.startsWith('/ipns') && !isIPFS.multihash(folderKey.slice(6))) {
    resolveDNS(folderKey, (err, resolved) => {
      if (err)
        return cb(err)
      folderKey = resolved
      start()
    })
  } else {
    start()
  }

  function start() {
    log.debug('[IPFS] Looking up', path, 'in', folderKey)
    var pathParts = fixPath(path).split('/')
    descend(folderKey)

    function descend (key) {
      log.debug('[IPFS] Listing...', key)
      ipfsApi.object.links(key, { enc: (typeof key == 'string' ? 'base58' : false) }, (err, links) => {
        if (err) {
          if (err.code == 'ECONNREFUSED') {
            // daemon turned off
            shutdown()
          }
          return cb(err)
        }
        
        // lookup the entry
        log.debug('[IPFS] folder listing for', key, links)
        var link = findLink(links, pathParts.shift())
        if (!link)
          return cb({ notFound: true, links })

        // done?
        if (pathParts.length === 0)
          return cb(null, link)

        // descend!
        descend(link.hash)
      })
    }
  }

  function fixPath (str) {
    if (!str) str = ''
    if (str.charAt(0) == '/') str = str.slice(1)
    return str
  }
}

var dnsEntryRegex = /^dnslink=(\/ip[nf]s\/.*)/
function resolveDNS (folderKey, cb) {
  // pull out the name
  var name = folderKey.slice(6) // strip off the /ipns/
  if (name.endsWith('/'))
    name = name.slice(0, -1)

  // do a dns lookup
  log.debug('[IPFS] DNS TXT lookup for name:', name)
  dns.resolveTxt(name, (err, records) => {
    log.debug('[IPFS] DNS TXT results for', name, err || records)
    if (err)
      return cb(err)

    // scan the txt records for a valid entry
    for (var i=0; i < records.length; i++) {
      var match = dnsEntryRegex.exec(records[i][0])
      if (match) {
        log.debug('[IPFS] DNS resolved', name, 'to', match[1])
        return cb(null, match[1])
      }
    }

    cb({ code: 'ENOTFOUND' })
  })
}

function findLink (links, path) {
  if (!path || path == '/')          path = 'index.html'
  if (path && path.charAt(0) == '/') path = path.slice(1)
    
  for (var i=0; i < links.length; i++) {
    if (links[i].name == path)
      return links[i]
  }
}

// internal methods
// =

function parseConfig (confPath, done) {
  try {
    const file = fs.readFileSync(path.join(confPath, 'config'))
    const parsed = JSON.parse(file)
    done(null, parsed)
  } catch (err) {
    done(err)
  }
}