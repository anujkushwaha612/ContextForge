// providers/groq.js
export const GroqAdapter = {
  name: 'groq',
  hostname: 'api.groq.com',
  port: 443,
  transformHeaders: (incomingHeaders) => {
    const outgoing = { ...incomingHeaders };
    outgoing.host = 'api.groq.com';
    
    // Strip Anthropic-specific headers that Groq doesn't understand
    delete outgoing['anthropic-version'];
    delete outgoing['anthropic-beta'];
    
    // Groq expects OpenAI-style authorization
    if (!outgoing['authorization'] && process.env.GROQ_API_KEY) {
      outgoing['authorization'] = `Bearer ${process.env.GROQ_API_KEY}`;
    }
    
    return outgoing;
  },
  transformPath: (incomingUrl) => {
    // Claude Code sends Anthropic endpoints - translate to OpenAI/Groq endpoints
    if (incomingUrl.startsWith('/v1/messages')) {
      // Convert Anthropic's /v1/messages to Groq's /openai/v1/chat/completions
      // Preserve any query parameters
      const urlParts = incomingUrl.split('?');
      const queryString = urlParts.length > 1 ? `?${urlParts[1]}` : '';
      return `/openai/v1/chat/completions${queryString}`;
    }
    
    // For other Anthropic endpoints, map them appropriately
    if (incomingUrl.startsWith('/v1')) {
      // Generic fallback: convert /v1/* to /openai/v1/*
      return `/openai${incomingUrl}`;
    }
    
    return incomingUrl;
  }
};