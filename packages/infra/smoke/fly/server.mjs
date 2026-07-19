import http from "node:http";

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: true,
      service: "fly-io",
      message: "lambda-fluid Fly.io smoke test passed",
      path: request.url,
      checkedAt: new Date().toISOString(),
    })
  );
});

server.listen(8080, "0.0.0.0");
