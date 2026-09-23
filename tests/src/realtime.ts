import WebSocket from 'ws';
import { poll } from './durable';

/**
 * AppSync Events subscriber with API key auth, the same protocol the frontend's
 * appSyncEvents.ts uses (realtime host, header-<base64url> subprotocol).
 */
export class RealtimeSubscriber {
  private ws?: WebSocket;
  private received: { channel: string; event: any }[] = [];
  private channels = new Map<string, string>();

  constructor(private readonly httpHost: string, private readonly apiKey: string) {}

  private get auth() {
    return { host: this.httpHost, 'x-api-key': this.apiKey };
  }

  async connect() {
    const realtimeHost = this.httpHost.replace('.appsync-api.', '.appsync-realtime-api.');
    const header = Buffer.from(JSON.stringify(this.auth)).toString('base64url');
    // LocalStack's certificate has no SAN for *.appsync-realtime-api.localhost.localstack.cloud (GAPS.md).
    this.ws = new WebSocket(`wss://${realtimeHost}/event/realtime`, [`header-${header}`, 'aws-appsync-event-ws'], {
      rejectUnauthorized: false,
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'data') {
        this.received.push({ channel: this.channels.get(msg.id) ?? '', event: JSON.parse(msg.event) });
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('error', reject);
      this.ws!.once('open', () => this.ws!.send(JSON.stringify({ type: 'connection_init' })));
      this.ws!.on('message', (raw) => {
        if (JSON.parse(raw.toString()).type === 'connection_ack') resolve();
      });
    });
    return this;
  }

  async subscribe(channel: string) {
    const id = `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.channels.set(id, channel);
    const ack = new Promise<void>((resolve, reject) => {
      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== id) return;
        this.ws!.off('message', onMessage);
        msg.type === 'subscribe_success' ? resolve() : reject(new Error(`Subscribe to ${channel} failed: ${raw}`));
      };
      this.ws!.on('message', onMessage);
    });
    this.ws!.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: this.auth }));
    await ack;
  }

  async waitFor(channel: string, type: string, orderId: string, timeoutMs = 20000) {
    return poll(async () => this.received.find((r) =>
      r.channel === channel && r.event.type === type && r.event.orderId === orderId), `${type} on ${channel}`, timeoutMs, 200);
  }

  close() {
    this.ws?.close();
  }
}
