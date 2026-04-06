FROM node:20-alpine

# Run as non-root for security
RUN addgroup -S razorgen && adduser -S razorgen -G razorgen

WORKDIR /app

# Copy app files (never copy .env — mount it at runtime)
COPY server.js index.html ./

# Own the files
RUN chown -R razorgen:razorgen /app

USER razorgen

EXPOSE 3000

# Health check — Docker will restart container if this fails
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/login || exit 1

CMD ["node", "server.js"]
