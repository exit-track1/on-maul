FROM public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY package.json package-lock.json ./
COPY fe/package.json ./fe/package.json
COPY server/package.json ./server/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server/src ./server/src
COPY shared/src ./shared/src
COPY src ./src
COPY public ./public
COPY fixtures/bundle.json ./fixtures/bundle.json
COPY fe/dist ./fe/dist
# SSM extracts the private archive with umask 077; runtime UID differs from root.
RUN chmod -R a+rX server shared src public fixtures fe/dist
ENV NODE_ENV=production
USER node
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.ON_PORT||8090)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--env-file=/run/onmaul/runtime.env", "--import=tsx", "server/src/main.ts"]
