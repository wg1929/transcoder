'use strict'

const { EventEmitter } = require('events')
const path = require('path')
const fs = require('fs')
const os = require('os')
const uuid = require('uuid')
const ffmpeg = require('fluent-ffmpeg')
const { mapLimit } = require('async')
const { forEach } = require('lodash')
const once = require('once')

const tutils = require('./utils')
// const db = require('../db')
const config = {
  FFMPEG_PATH: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg',
  FFPROBE_PATH: process.env.FFPROBE_PATH || '/usr/bin/ffprobe',
  IPFS_API: '/ip4/127.0.0.1/tcp/5002'
}

// var ipfs = ipfsAPI(config.IPFS_API)
ffmpeg.setFfprobePath(config.FFPROBE_PATH)

class Job extends EventEmitter {
  constructor (opts) {
    super()
    this.id = this._generateId()
    // TODO have a choice of a different folder instead of tmp
    this.rootPath = path.join(os.tmpdir(), 'paratii-' + this.id)

    this.hash = opts.hash
    this.pipfs = opts.pipfs
    this.meta = {}
  }

  _generateId () {
    // only generate the id once.
    if (this.id) { return this.id }
    return uuid.v4()
  }

  generateScreenshots (inputPath, outputFolder, callback) {
    let outputedFileNames = null
    ffmpeg(inputPath)
      .on('filenames', (filenames) => {
        console.log('Will generate ' + filenames)
        outputedFileNames = filenames
      })
      .on('end', () => {
        console.log('screenshots generated!')
        callback(null, outputedFileNames)
      })
      .screenshots({
        count: 4,
        folder: outputFolder,
        filename: 'thumbnail-%r.png'
      })
  }

  generateManifest (cb) {
    let master = '#EXTM3U\n'
    master += '#EXT-X-VERSION:6\n'

    let resolutionLine = (size) => {
      return `#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${tutils.getBandwidth(tutils.getHeight(size))},CODECS="avc1.4d001f,mp4a.40.2",RESOLUTION=${tutils.calculateWidth(this.codecData, tutils.getHeight(size))},NAME=${tutils.getHeight(size)}\n`
    }
    let result = master
    console.log('availableSizes: ', this.resolution.availableSizes)
    forEach(this.resolution.availableSizes, (size) => {
      // log(`format: ${JSON.stringify(formats[size])} , size: ${size}`)
      result += resolutionLine(size)
      result += String(size.split('x')[1]) + '.m3u8\n'
    })

    cb(null, result)
  }

  getVideoMetadata (cb) {
    let fileStream

    try {
      console.log('getting metadata for ', this.hash)
      fileStream = this.pipfs.ipfs.files.catReadableStream(this.hash)
    } catch (e) {
      if (e) return cb(this._handleError(e))
    }

    fileStream.unpipe = function () { }
    ffmpeg(fileStream.resume())
      .ffprobe(0, (err, metadata) => {
        if (err) return cb(this._handleError(err))
        // Ref: metadata object example https://github.com/fluent-ffmpeg/node-fluent-ffmpeg#reading-video-metadata
        console.log(metadata)
        this.duration = metadata.format.duration
        for (var stream of metadata.streams) {
          if (stream.codec_type === 'video') {
            this.resolution = {
              width: stream.width,
              height: stream.height,
              display_aspect_ratio: stream.display_aspect_ratio,
              availableSizes: tutils.getPossibleBitrates(stream.height),
              bitrate: stream.bit_rate
            }

            this.meta.video = stream

            return cb(null, {
              width: stream.width,
              height: stream.height,
              display_aspect_ratio: stream.display_aspect_ratio,
              availableSizes: tutils.getPossibleBitrates(stream.height),
              bitrate: stream.bit_rate
            })
          }
        }
      })
  }

  _handleError (e) {
    // TODO: handle errors properly like a gentleman.
    return e
  }

  run (cb) {
    let stream

    try {
      stream = this.pipfs.ipfs.files.catReadableStream(this.hash)
    } catch (e) {
      if (e) return cb(this._handleError(e))
    }

    fs.mkdir(this.rootPath, (err) => {
      if (err) return cb(this._handleError(err))

      this.command = ffmpeg(stream)
        // .inputOptions('-strict -2')
        .addOption('-preset', 'veryfast')
        .addOption('-framerate', 30)
        .addOption('-tune', 'zerolatency')
        .addOption('-profile:v', 'baseline')
        .addOption('-level', 3.0)
        .addOption('-start_number', 0)
        .videoCodec('libx264')
        // set audio bitrate
        .audioBitrate('64k')
        // set audio codec
        .audioCodec('aac')
        // set number of audio channels
        .audioChannels(2)
        // set hls segments time
        .addOption('-hls_time', 5)
        // include all the segments in the list
        .addOption('-hls_list_size', 0)
        .addOption('-f', 'hls')
        .on('stderr', (out) => {
          console.log('stderr: ', out)
        })
        //
        //
      let sizes = this.resolution.availableSizes
      mapLimit(sizes, sizes.length, (size, next) => {
        next = once(next)
        console.log(`launching ${size} converter, storing as ${this.rootPath}/${size.split('x')[1]}`)
        this.command.clone()
        .size(size)
        .on('codecData', (data) => {
          console.log('data: ', data)
          this.codecData = data
          console.log('Input is ' + data.audio + ' audio ' +
            'with ' + data.video + ' video')
        })
        .on('end', () => {
          console.log(this.id, ':', size, '\t DONE')
          next(null)
        })
        .on('error', (err) => {
          console.log('error: ', this.id, ':', size, '\t', err)
          return next(err)
        })
        .on('progress', (progress) => {
          console.log(this.id, ':', size, '\t',
            tutils.getProgressPercent(progress.timemark, this.codecData.duration).toFixed(2))
        })
        .save(this.rootPath + '/' + String(size.split('x')[1]) + '.m3u8')
        .run()
      }, (err, results) => {
        if (err) return cb(this._handleError(err))
        this.result = this.result || {}
        this.result['root'] = this.rootPath
        console.log('result after mapLimit ', this.result)
        this.generateManifest((err, masterPlaylist) => {
          if (err) return cb(this._handleError(err))
          console.log('masterPlaylist: ', masterPlaylist)
          fs.writeFile(this.result.root + '/master.m3u8', masterPlaylist, (err, done) => {
            if (err) return cb(this._handleError(err))
            this.generateScreenshots(this.result.root + '/master.m3u8', this.rootPath, (err, screenshots) => {
              if (err) return cb(this._handleError(err))
              this.result.screenshots = screenshots
              console.log('rootPath: ', this.rootPath)
              this.pipfs.addDirToIPFS(this.rootPath, (err, resp) => {
                if (err) return cb(this._handleError(err))
                console.log('Master Playlist is added to IPFS ', resp)
                this.result.master = resp
                cb(null, this.result)
              })
            })
          })
        })
        // cb(null, this.result)
      })
    })
  }

  start (cb) {
    this.getVideoMetadata((err, meta) => {
      if (err) throw err
      this.run(cb)
    })
  }
}

module.exports = Job
