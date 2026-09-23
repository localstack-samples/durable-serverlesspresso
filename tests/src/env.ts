// The suite talks to LocalStack only through the standard AWS SDK settings.
// Nothing in the tests is LocalStack specific: AWS_ENDPOINT_URL routes every client.
process.env.AWS_ENDPOINT_URL ??= 'http://localhost.localstack.cloud:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.STACK_NAME ??= 'durable-serverlesspresso';
