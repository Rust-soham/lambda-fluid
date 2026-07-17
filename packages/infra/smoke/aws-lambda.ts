export const handler = async (event: unknown) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      service: "aws-lambda",
      message: "lambda-fluid AWS smoke test passed",
      event,
      checkedAt: new Date().toISOString(),
    }),
  };
};

export default handler;
