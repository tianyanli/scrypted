import { reservePorts } from '@homebridge/camera-utils';
import { createBindUdp, createBindZero } from '@scrypted/common/src/listen-cluster';
import dgram from 'dgram';
import { ReplaySubject, timer } from 'rxjs';
import { createStunResponder, RtpDescription, RtpOptions, sendStunBindingRequest } from '../../sip/src/rtp-utils';
import { SipCall, SipOptions } from './sip-call';
import { Subscribed } from '../../sip/src/subscribed';

export class SipSession extends Subscribed {
  private hasStarted = false
  private hasCallEnded = false
  private onCallEndedSubject = new ReplaySubject(1)
  private sipCall: SipCall
  onCallEnded = this.onCallEndedSubject.asObservable()

  constructor(
    public readonly console: any,
    public readonly sipOptions: SipOptions,
    public readonly rtpOptions: RtpOptions,
    public readonly audioSplitter: dgram.Socket,
    public audioRtcpSplitter: dgram.Socket,
    public readonly videoSplitter: dgram.Socket,
    public videoRtcpSplitter: dgram.Socket,
    public readonly cameraName: string
  ) {
    super()

    this.sipCall = this.createSipCall(this.sipOptions)
  }

  static async createSipSession(console: any, cameraName: string, sipOptions: SipOptions) {
      const audioSplitter = await createBindZero(),
      audioRtcpSplitter = await createBindUdp(audioSplitter.port + 1),
      videoSplitter = await createBindZero(),
      videoRtcpSplitter = await createBindUdp(videoSplitter.port + 1),
      rtpOptions = {
        audio: {
          port: audioSplitter.port,
          rtcpPort: audioRtcpSplitter.port
        },
        video: {
          port: videoSplitter.port,
          rtcpPort: videoRtcpSplitter.port
        }
      }

    return new SipSession(
      console,
      sipOptions,
      rtpOptions,
      audioSplitter.server,
      audioRtcpSplitter.server,
      videoSplitter.server,
      videoRtcpSplitter.server,
      cameraName
    )
  }

  createSipCall(sipOptions: SipOptions) {
    if (this.sipCall) {
      this.sipCall.destroy()
    }

    const call = (this.sipCall = new SipCall(
      this.console,
      sipOptions,
      this.rtpOptions
    ))

    this.addSubscriptions(
      call.onEndedByRemote.subscribe(() => this.callEnded(false))
    )

    return this.sipCall
  }

  async start(): Promise<RtpDescription> {
    if (this.hasStarted) {
      throw new Error('SIP Session has already been started')
    }
    this.hasStarted = true

    if (this.hasCallEnded) {
      throw new Error('SIP Session has already ended')
    }

    try {
      await this.sipCall.register();
      const rtpDescription = await this.sipCall.invite(),
        sendStunRequests = () => {
          sendStunBindingRequest({
            rtpSplitter: this.audioSplitter,
            rtcpSplitter: this.audioRtcpSplitter,
            rtpDescription,
            localUfrag: this.sipCall.audioUfrag,
            type: 'audio',
          })
          sendStunBindingRequest({
            rtpSplitter: this.videoSplitter,
            rtcpSplitter: this.videoRtcpSplitter,
            rtpDescription,
            localUfrag: this.sipCall.videoUfrag,
            type: 'video',
          })
        }

      // if rtcp-mux is supported, rtp splitter will be used for both rtp and rtcp
      if (rtpDescription.audio.port === rtpDescription.audio.rtcpPort) {
        this.audioRtcpSplitter.close()
        this.audioRtcpSplitter = this.audioSplitter
      }
      if (rtpDescription.video.port === rtpDescription.video.rtcpPort) {
        this.videoRtcpSplitter.close()
        this.videoRtcpSplitter = this.videoSplitter
      }

      if (rtpDescription.video.iceUFrag) {
        // ICE is supported
        this.console.debug(`Connecting to ${this.cameraName} using ICE`)
        createStunResponder(this.audioSplitter)
        createStunResponder(this.videoSplitter)

        sendStunRequests()
      } else {
        // ICE is not supported, use stun as keep alive
        this.console.debug(`Connecting to ${this.cameraName} using STUN`)
        this.addSubscriptions(
          // hole punch every .5 seconds to keep stream alive and port open (matches behavior from Ring app)
          timer(0, 500).subscribe(sendStunRequests)
        )
      }

      this.audioSplitter.once('message', () => {
        this.console.debug(`Audio stream latched for ${this.cameraName} on port: ${this.rtpOptions.audio.port}`)
      })
      this.videoSplitter.once('message', () => {
        this.console.debug(`Video stream latched for ${this.cameraName} on port: ${this.rtpOptions.video.port}`)
      })

      return rtpDescription
    } catch (e) {

      this.callEnded(true)
      throw e
    }
  }

  static async reserveRtpRtcpPorts() {
    const ports = await reservePorts({ count: 4, type: 'udp' })
    return ports
  }

  private callEnded(sendBye: boolean) {
    if (this.hasCallEnded) {
      return
    }
    this.hasCallEnded = true

    if (sendBye) {
      this.sipCall.sendBye()
      .then(() => {
        // clean up
        this.console.log("sip-session callEnded")
        this.onCallEndedSubject.next(null)
        this.sipCall.destroy()
        this.videoSplitter.close()
        this.audioSplitter.close()
        this.audioRtcpSplitter.close()
        this.videoRtcpSplitter.close()
        this.unsubscribe()
        this.console.log("sip-session callEnded: done")
      })
      .catch()
    }
  }

  stop() {
    this.callEnded(true)
  }
}