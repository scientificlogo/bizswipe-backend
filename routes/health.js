module.exports = async (fastify) => {
  fastify.get('/health', async () => ({
    status:'ok', app:'BizSwipe Backend',
    version:'2.0.0', timestamp: new Date().toISOString(),
  }));
};
