FROM oven/bun:1.2.23-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY rules ./rules
ENV RENTEMESTER_COMPANY=/company
VOLUME ["/company", "/import"]
ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["system", "healthcheck"]
