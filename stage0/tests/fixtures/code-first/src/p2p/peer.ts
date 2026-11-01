import * as arc from "open-arc";

export interface Gossip {
  id: string;
  origin: string;
  ttl: number;
  body: string;
}
/** The network as one peer sees it. Tests get the project's fake for this type. */
export interface Transport {
  send(from: string, to: string, msg: Gossip): Promise<void>;
}

export class Peer {
  readonly self: string;
  readonly peers: string[];
  readonly net: Transport;
  /** Message ids already handled, oldest first. */
  seen: string[] = [];
  delivered: string[] = [];

  constructor(self: string, peers: string[], net: Transport) {
    this.self = self;
    this.peers = peers;
    this.net = net;
  }

  /**
   * A seen id: false, nothing else. Otherwise remember the id, deliver the body (push it to delivered), and when
   * ttl > 0 send a copy with ttl - 1 to the first two peers in sorted order, skipping `from`, msg.origin and self.
   * @returns whether the message was delivered here
   * @arc calls this.net.send
   */
  async receive(from: string | null, msg: Gossip): Promise<boolean> {
    return arc.todo();
  }
}
