// providers/ollama.js

export class OllamaAdapter {
  constructor() {
    this.name     = "ollama";
    this.hostname = "127.0.0.1";
    this.port     = 11434;
  }

  transformHeaders(incomingHeaders) {
    const outgoing = { ...incomingHeaders };

    // Let Ollama see itself as the target host
    outgoing.host = "127.0.0.1:11434";

    // Remove hop-by-hop headers
    delete outgoing["content-length"];
    delete outgoing["accept-encoding"];
    delete outgoing["connection"];

    return outgoing;
  }

  transformPath(incomingUrl) {
    // Forward exactly as received
    return incomingUrl;
  }
}