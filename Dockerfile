FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=7860 \
    HOST=0.0.0.0

WORKDIR /app
COPY --chown=node:node package.json config.mjs server.mjs ./
COPY --chown=node:node public/ ./public/
COPY --chown=node:node data/ ./data/
COPY --chown=node:node docs/openapi.json ./docs/openapi.json

USER node
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
