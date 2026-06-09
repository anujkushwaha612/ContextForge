// providers/anthropic.js
export const AnthropicAdapter = {
  name: 'anthropic',
  hostname: 'api.anthropic.com',
  transformHeaders: (headers) => {
    // Anthropic expects x-api-key instead of Authorization, 
    // and requires anthropic-version header!
    const updated = { ...headers, host: 'api.anthropic.com' };
    if (updated.authorization) {
      updated['x-api-key'] = updated.authorization.replace('Bearer ', '');
      delete updated.authorization;
    }
    updated['anthropic-version'] = '2023-06-01';
    return updated;
  },
  transformPath: (url) => {
    // If client queries /v1/chat/completions but we resolve to anthropic, 
    // map it to their native messages endpoint
    if (url.includes('/chat/completions')) return '/v1/messages';
    return url;
  }
};
