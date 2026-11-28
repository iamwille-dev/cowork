export default {
  async rewrites() {
    return [
      { source: '/integrations/agent-connections/:path*', destination: 'http://127.0.0.1:4000/integrations/agent-connections/:path*' },
      { source: '/mcp', destination: 'http://127.0.0.1:4000/mcp' },
      { source: '/.well-known/oauth-protected-resource/mcp', destination: 'http://127.0.0.1:4000/.well-known/oauth-protected-resource/mcp' },
      { source: '/api/web-chat', destination: 'http://127.0.0.1:4402/api/web-chat' },
      { source: '/api/agents/:agent(developer|sales-lead)/channels/slack/webhook', destination: 'http://127.0.0.1:4402/api/agents/:agent/channels/slack/webhook' },
      { source: '/api/slack/agents/:agent', destination: 'http://127.0.0.1:4402/api/slack/agents/:agent' },
      { source: '/integrations/slack/managed/:id/oauth/callback', destination: 'http://127.0.0.1:4402/integrations/slack/managed/:id/oauth/callback' },
      { source: '/integrations/slack/managed/:id/events', destination: 'http://127.0.0.1:4402/integrations/slack/managed/:id/events' },
      { source: '/api/slack/:agent(ada|sam)', destination: 'http://127.0.0.1:4402/api/slack/:agent' },
      { source: '/integrations/slack/:agent(ada|sam)/oauth/callback', destination: 'http://127.0.0.1:4402/integrations/slack/:agent/oauth/callback' },
      { source: '/integrations/slack/:agent(ada|sam)/events', destination: 'http://127.0.0.1:4402/integrations/slack/:agent/events' },
      { source: '/api/slack', destination: 'http://127.0.0.1:4402/api/slack' },
      { source: '/integrations/slack/oauth/callback', destination: 'http://127.0.0.1:4402/integrations/slack/oauth/callback' },
      { source: '/integrations/slack/events', destination: 'http://127.0.0.1:4402/integrations/slack/events' },
      { source: '/api/:path*', destination: 'http://127.0.0.1:4000/api/:path*' },
    ];
  },
};
