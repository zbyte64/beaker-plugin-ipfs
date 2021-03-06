const { protocol } = require('electron')
const url = require('url')
const once = require('once')
const http = require('http')
const crypto = require('crypto')
const listenRandomPort = require('listen-random-port')
const log = require('loglevel')
const Unixfs = require('ipfs-unixfs')
const identify = require('identify-filetype')
const mime = require('mime')
const ipfs = require('../lib/ipfs')
const errorPage = require('../lib/error-page')

// constants
// =

// how long till we give up?
const REQUEST_TIMEOUT_MS = 30e3 // 30s

// content security policies
const CSP = "default-src 'self' beaker:; img-src 'self' data:; plugin-types 'none';"

// globals
// =

var serverPort // port assigned to us
var requestNonce // used to limit access to the server from the outside

// exported api
// =

exports.scheme = 'ipfs'
exports.label = 'IPFS'
exports.isStandardURL = false
exports.isInternal = false

exports.register = function () {
  // generate a secret nonce
  requestNonce = crypto.randomBytes(4).readUInt32LE(0)

  // setup the protocol handler
  protocol.registerHttpProtocol('ipfs', 
    (request, cb) => {
      // send requests to the protocol server
      cb({
        method: request.method,
        url: 'http://localhost:'+serverPort+'/?url='+encodeURIComponent(request.url)+'&nonce='+requestNonce
      })
    }, err => {
      if (err)
        throw ProtocolSetupError(err, 'Failed to create protocol: ipfs')
    }
  )

  // create the internal ipfs HTTP server
  var server = http.createServer(ipfsServer)
  listenRandomPort(server, { host: '127.0.0.1' }, (err, port) => serverPort = port)
}

function ipfsServer (req, res) {
  var cb = once((code, status) => { 
    res.writeHead(code, status, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'unsafe-inline';" })
    res.end(errorPage(code + ' ' + status))
  })
  function redirectToFolder () {
    // header-redirects crash electron (https://github.com/electron/electron/issues/6492)
    // use this instead, for now
    res.writeHead(200, 'OK', { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP })
    res.end('<meta http-equiv="refresh" content="0;URL=ipfs:'+folderKey+reqPath+'/">')    
  }
  var queryParams = url.parse(req.url, true).query

  // check the nonce
  // (only want this process to access the server)
  if (queryParams.nonce != requestNonce)
    return cb(403, 'Forbidden')

  // check if we have the daemon
  if (!ipfs.getApi()) {
    ipfs.setup() // try to setup the daemon
    return cb(500, 'IPFS Daemon not found. Start the daemon and try again.')
  }

  // validate request
  var hostMatch = /ipfs:(\/[a-z]+\/[0-9a-zA-Z-.]+)/i.exec(queryParams.url)
  if (!hostMatch)
    return cb(404, 'Invalid URL')
  var folderKey = hostMatch[1]
  var reqPath = queryParams.url.slice(hostMatch[0].length)
  if (reqPath.indexOf('#') !== -1) // strip out the hash segment
    reqPath = reqPath.slice(0, reqPath.indexOf('#'))
  if (req.method != 'GET')
    return cb(405, 'Method Not Supported')

  // redirect if no path, otherwise sub-resource requests will fail
  if (reqPath == '')
    return redirectToFolder()

  // stateful vars that may need cleanup
  var timeout
  function cleanup () {
    if (timeout)
      clearTimeout(timeout)
  }

  // track whether the request has been aborted by client
  // if, after some async, we find `aborted == true`, then we just stop
  var aborted = false
  req.once('aborted', () => {
    aborted = true
    cleanup()
    log.debug('[IPFS] Request aborted by client')
  })

  // setup a timeout
  timeout = setTimeout(() => {
    if (aborted) return
    log.debug('[IPFS] Timed out searching for', folderKey)
    cb(408, 'Timed out')
  }, REQUEST_TIMEOUT_MS)

    // list folder contents
  log.debug('[IPFS] Attempting to list folder', folderKey)
  ipfs.lookupLink(folderKey, reqPath, (err, link) => {
    if (aborted)
      return
    if (err) {
      cleanup()

      if (err.notFound) {
        // if we're looking for a directory, just give a file listing
        if (Array.isArray(err.links) && reqPath.charAt(reqPath.length - 1) == '/') {
          res.writeHead(200, 'OK', {
            'Content-Type': 'text/html',
            'Content-Security-Policy': CSP
          })
          var upLink = (reqPath == '/') ? '' : `<p><a href="..">..</a></p>`
          res.end(`<h1>File listing for ${reqPath}</h1>`+upLink+err.links.map(link => {
            if (!link.name) return ''
            return `<p><a href="./${link.name}">${link.name}</a></p>`
          }).join(''))
          return
        }

        return cb(404, 'File Not Found')
      }
      if (err.notReady) {
        ipfs.setup() // try to setup the daemon
        return cb(500, 'IPFS Daemon not found. Start the daemon and try again.')
      }

      // QUESTION: should there be a more specific error response?
      // not sure what kind of failures can occur here (other than broken pipe)
      // -prf
      log.debug('[IPFS] Folder listing errored', err)
      return cb(500, 'Failed')
    }

    // fetch the data
    log.debug('[IPFS] Link found:', reqPath || link.name, link)
    ipfs.getApi().object.data(link.hash, (err, marshaled) => {
      if (aborted)
        return
      cleanup()

      if (err) {
        // TODO: what's the right error for this?
        log.debug('[IPFS] Data fetch failed', err)
        return cb(500, 'Failed')
      }

      // parse the data
      var unmarshaled = Unixfs.unmarshal(marshaled)
      var data = unmarshaled.data

      // directory? redirect with a '/' appended
      if (unmarshaled.type == 'directory')
        return redirectToFolder()
      
      // try to identify the type by the buffer contents
      var mimeType
      var identifiedExt = data && identify(data)
      if (identifiedExt)
        mimeType = mime.lookup(identifiedExt)
      if (mimeType)
        log.debug('[IPFS] Identified entry mimetype as', mimeType)
      else {
        // fallback to using the entry name
        mimeType = mime.lookup(link.name)
        if (mimeType == 'application/octet-stream')
          mimeType = 'text/plain' // TODO look if content is textlike?
        log.debug('[IPFS] Assumed mimetype from link name', mimeType)
      }

      res.writeHead(200, 'OK', {
        'Content-Type': mimeType,
        'Content-Security-Policy': CSP
      })
      res.end(data)
    })
  })
}