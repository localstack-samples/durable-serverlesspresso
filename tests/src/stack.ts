import { CloudFormationClient, DescribeStacksCommand, DescribeStackResourceCommand } from '@aws-sdk/client-cloudformation';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const lambda = new LambdaClient({});
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cfn = new CloudFormationClient({});

export interface Stack {
  apiUrl: string;
  ordersTable: string;
  configTable: string;
  functionName: string;
  appSyncHttpHost: string;
  appSyncApiKey: string;
}

let cached: Stack | undefined;

export async function stack(): Promise<Stack> {
  if (cached) return cached;
  const name = process.env.STACK_NAME!;
  const res = await cfn.send(new DescribeStacksCommand({ StackName: name }));
  const out = Object.fromEntries(res.Stacks![0].Outputs!.map((o) => [o.OutputKey!, o.OutputValue!]));

  // The template's ApiUrl output hardcodes amazonaws.com. Build the LocalStack URL from the API ID.
  const api = await cfn.send(new DescribeStackResourceCommand({ StackName: name, LogicalResourceId: 'CoffeeOrderingApi' }));
  const restApiId = api.StackResourceDetail!.PhysicalResourceId!;
  const region = process.env.AWS_REGION!;
  const apiUrl = process.env.AWS_ENDPOINT_URL
    ? `https://${restApiId}.execute-api.localhost.localstack.cloud:4566/prod`
    : `https://${restApiId}.execute-api.${region}.amazonaws.com/prod`;

  cached = {
    apiUrl,
    ordersTable: out.OrdersTableName,
    configTable: out.ConfigTableName,
    functionName: out.DurableFunctionName,
    appSyncHttpHost: new URL(out.AppSyncHttpEndpoint).host,
    appSyncApiKey: out.AppSyncApiKey,
  };
  return cached;
}
