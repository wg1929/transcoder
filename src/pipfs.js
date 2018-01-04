/**
 * @module TranscoderIPFS integration.
 */

'use strict'

const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const Ipfs = require('ipfs')
const HttpAPI = require('ipfs/src/http/index.js')
const ParatiiProtocol = require('paratii-protocol')
const pull = require('pull-stream')
const pullFile = require('pull-file')
const { eachSeries, nextTick } = require('async')
const once = require('once')

const log = require('debug')('paratii:ipfs')
log.error = require('debug')('paratii:ipfs:error')

class PIPFS extends EventEmitter {
  constructor (opts) {
    super()

    this.config = opts
    this.ipfs = new Ipfs(this.config)

    this.ipfs.on('ready', () => {
      log('up and running ... repo:', this.ipfs.repo.path())
      log('Hooking up paratii-protocol')
      this.ipfs.id().then((id) => {
        this.id = id
        this.protocol = new ParatiiProtocol(
          this.ipfs._libp2pNode,
          this.ipfs._repo.blocks,
          // add ETH Address here.
          '0xPlace_holder_here_till_I_add_utils'
        )

        this.protocol.notifications.on('message:new', (peerId, msg) => {
          console.log('[paratii-protocol] ', peerId.toB58String(), ' new Msg: ', msg)
        })

        this.protocol.notifications.on('command:transcode', (peerId, command) => {
          log('got Transcode command from ', peerId.toB58String(), ' | command: ', command)
          this.emit('transcode', peerId, command)
        })

        this.protocol.start(() => {
          log('paratii-protocol is live.')
          this.emit('ready')
          // return cb(null)
        })
      })

      this.ipfs.on('error', (err) => {
        if (err) throw err
      })
    })
  }

  startAPI (cb) {
    this.httpAPI = new HttpAPI(this.ipfs, null, null)

    this.httpAPI.start((err) => {
      if (err && err.code === 'ENOENT' && err.message.match(/Uninitalized repo/i)) {
        log('Error: no initialized ipfs repo found in ' + this.node.repo.path())
        log('please run: jsipfs init')
      }
      if (err) {
        throw err
      }
      log('Daemon is ready')
      cb()
    })
  }

  upload (files, callback) {
    let hashes = []
    pull(
      pull.values(files),
      pull.through((file) => {
        console.log('Adding ', file)
        // fileSize = file.size
        // total = 0
      }),
      pull.asyncMap((file, cb) => pull(
        pull.values([{
          path: file,
          // content: pullFilereader(file)
          content: pull(
            pullFile(file)
            // pull.through((chunk) => updateProgress(chunk.length))
          )
        }]),
        this.ipfs.files.addPullStream({chunkerOptions: {maxChunkSize: 64048}}), // default size 262144
        pull.collect((err, res) => {
          if (err) {
            return cb(err)
          }
          const file = res[0]
          console.log('Adding %s finished as %s', file.path, file.hash)
          hashes.push(file)

          cb(null, file)
        }))),
      pull.collect((err, files) => {
        if (err) {
          throw err
        }
        log('uploaded To IPFS ', files)
        callback(null, hashes)
        // if (files && files.length) {
        // }
      })
    )
  }

  addDirToIPFS (dirPath, cb) {
    cb = once(cb)
    let resp = null
    this.ipfs.files.createAddStream((err, addStream) => {
      if (err) return cb(err)
      addStream.on('data', (file) => {
        console.log('dirPath ', dirPath)
        console.log('file Added ', file)
        if ('/' + file.path === dirPath) {
          console.log('this is the hash to return ')
          resp = file
          nextTick(() => cb(null, resp))
        }
      })

      addStream.on('end', () => {
        console.log('addStream ended')
        // nextTick(() => cb(null, resp))
      })

      fs.readdir(dirPath, (err, files) => {
        if (err) return cb(err)
        eachSeries(files, (file, next) => {
          next = once(next)
          try {
            console.log('reading file ', file)
            let rStream = fs.createReadStream(path.join(dirPath, file))
            rStream.on('error', (err) => {
              if (err) {
                log('rStream Error ', err)
                return next()
              }
            })
            if (rStream) {
              addStream.write({
                path: path.join(dirPath, file),
                content: rStream
              })
            }
          } catch (e) {
            if (e) {
              console.log('gotcha ', e)
            }
          } finally {
          }
          // next()
          nextTick(() => next())
        }, (err) => {
          if (err) return cb(err)
          // addStream.destroy()
          addStream.end()
        })
      })
    })
  }
}

module.exports = PIPFS
