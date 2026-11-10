import * as cdk from 'aws-cdk-lib/core';
import * as apig from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as node from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Construct } from 'constructs';
import { seedItems } from '../seed/movie-cast';

export interface AppApiStackProps extends cdk.StackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  authApiUrl: string;
}

export class AppApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppApiStackProps) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, 'MovieCastTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const appFn = (name: string, entry: string, environment: Record<string, string> = {}) =>
      new node.NodejsFunction(this, name, {
        architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: `${__dirname}/../lambdas/${entry}`,
        timeout: cdk.Duration.seconds(10),
        memorySize: 128,
        environment: {
          TABLE_NAME: table.tableName,
          REGION: this.region,
          ...environment,
        },
      });

    // Lambdas
    const getMovieRolesFn = appFn('GetMovieRolesFn', 'app/get-movie-roles.ts');
    const getActorFn = appFn('GetActorFn', 'app/get-actor.ts');
    const addMovieRoleFn = appFn('AddMovieRoleFn', 'app/add-movie-role.ts');
    const authorizerFn = appFn('AuthorizerFn', 'auth/authorizer.ts', {
      USER_POOL_ID: props.userPool.userPoolId,
      CLIENT_ID: props.userPoolClient.userPoolClientId,
    });

    table.grantReadData(getMovieRolesFn);
    table.grantReadData(getActorFn);
    table.grantReadWriteData(addMovieRoleFn);

    // Sample data, written once when the stack is created.
    const items = seedItems();
    if (items.length > 25) throw new Error('BatchWriteItem accepts at most 25 items');
    const seeder = new cr.AwsCustomResource(this, 'SeedMovieCastData', {
      onCreate: {
        service: 'DynamoDB',
        action: 'BatchWriteItem',
        parameters: {
          RequestItems: {
            [table.tableName]: items.map((item) => ({ PutRequest: { Item: marshall(item) } })),
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('MovieCastSeedData'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [table.tableArn] }),
      installLatestAwsSdk: false,
    });

    const userAuthorizer = new apig.RequestAuthorizer(this, 'UserAuthorizer', {
      handler: authorizerFn,
      identitySources: [apig.IdentitySource.header('cookie')],
      resultsCacheTtl: cdk.Duration.minutes(0),
    });

    const api = new apig.RestApi(this, 'AppApi', {
      description: 'Movie cast API',
      endpointTypes: [apig.EndpointType.REGIONAL],
      deployOptions: { stageName: 'dev' },
      defaultCorsPreflightOptions: {
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key'],
        allowMethods: ['OPTIONS', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowCredentials: true,
        allowOrigins: ['*'],
      },
    });

    // JSON error bodies, matching the lambdas' { message } format, for requests
    // rejected by API Gateway before they reach a lambda.
    const gatewayErrors: [string, apig.ResponseType, string, string][] = [
      ['MissingToken', apig.ResponseType.UNAUTHORIZED, '401', 'Missing token cookie. Sign in using the Auth API.'],
      ['InvalidToken', apig.ResponseType.ACCESS_DENIED, '401', 'Invalid or expired token. Sign in using the Auth API.'],
      ['InvalidApiKey', apig.ResponseType.INVALID_API_KEY, '403', 'Missing or invalid API key.'],
      ['UnknownRoute', apig.ResponseType.MISSING_AUTHENTICATION_TOKEN, '404', 'Resource not found.'],
    ];
    for (const [id, type, statusCode, message] of gatewayErrors) {
      api.addGatewayResponse(id, {
        type,
        statusCode,
        responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
        templates: { 'application/json': JSON.stringify({ message }) },
      });
    }

    const userAuth: apig.MethodOptions = {
      authorizer: userAuthorizer,
      authorizationType: apig.AuthorizationType.CUSTOM,
    };
    // Routes
    const moviesResource = api.root.addResource('movies');

    const movieRolesResource = moviesResource.addResource('{movieID}').addResource('roles');
    movieRolesResource.addMethod('GET', new apig.LambdaIntegration(getMovieRolesFn), userAuth);

    moviesResource
      .addResource('roles')
      .addMethod('POST', new apig.LambdaIntegration(addMovieRoleFn), { apiKeyRequired: true });

    api.root
      .addResource('actors')
      .addResource('{actorID}')
      .addMethod('GET', new apig.LambdaIntegration(getActorFn), userAuth);

    // Administrator API key; API Gateway generates its value at deployment time.
    const adminApiKey = api.addApiKey('AdminApiKey', {
      description: 'API key for administrator (POST) requests',
    });
    const usagePlan = api.addUsagePlan('AdminUsagePlan', {
      name: 'AdminUsagePlan',
      apiStages: [{ api, stage: api.deploymentStage }],
    });
    usagePlan.addApiKey(adminApiKey);

    // Repeated from the Cognito stack so all URLs needed by clients appear together.
    new cdk.CfnOutput(this, 'AuthApiUrl', { value: props.authApiUrl });
    new cdk.CfnOutput(this, 'AdminApiKeyId', {
      value: adminApiKey.keyId,
      description: 'aws apigateway get-api-key --include-value --api-key <id> to read the key',
    });
  }
}
