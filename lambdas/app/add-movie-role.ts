import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  actorKey,
  ddb,
  isNonEmptyString,
  isPositiveInteger,
  movieKey,
  type Role,
  tableName,
} from "../shared/db";
import { isResponse, parseJsonObject, response, serverError } from "../shared/http";
import { logRequest } from "../shared/request-logger";

// POST /movies/roles  { movieId, actorId, roleName, roleDescription }
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logRequest(event);

  const body = parseJsonObject(event);
  if (isResponse(body)) return body;

  const invalid = validateRole(body);
  if (invalid.length) {
    return response(400, {
      message: `Missing or invalid fields: ${invalid.join(", ")}`,
    });
  }
  const role: Role = {
    movieId: body.movieId as number,
    actorId: body.actorId as number,
    roleName: body.roleName as string,
    roleDescription: body.roleDescription as string,
  };
  const movie = movieKey(role.movieId);
  const actor = actorKey(role.actorId);

  try {
    // All three conditions are checked atomically: the movie and actor must
    // exist, and the actor must not already have a role in the movie.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: movie, SK: movie },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: actor, SK: actor },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: { PK: movie, SK: actor, ...role },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    );
    return response(201, { message: "Role added", data: role });
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      return cancelledResponse(err, role);
    }
    return serverError("DynamoDB error", err);
  }
};

// Names of the body fields that are missing or of the wrong type.
const validateRole = (body: Record<string, unknown>): string[] => [
  ...["movieId", "actorId"].filter((f) => !isPositiveInteger(body[f])),
  ...["roleName", "roleDescription"].filter((f) => !isNonEmptyString(body[f])),
];

// Maps the failed condition (in TransactItems order) to an error response.
const cancelledResponse = (
  err: TransactionCanceledException,
  role: Role
): APIGatewayProxyResult => {
  const [movieCheck, actorCheck, rolePut] = (err.CancellationReasons ?? []).map(
    (reason) => reason.Code === "ConditionalCheckFailed"
  );
  if (movieCheck) {
    return response(404, { message: `Movie ${role.movieId} not found` });
  }
  if (actorCheck) {
    return response(404, { message: `Actor ${role.actorId} not found` });
  }
  if (rolePut) {
    return response(409, {
      message: `Actor ${role.actorId} already has a role in movie ${role.movieId}`,
    });
  }
  return serverError("Transaction cancelled", err);
};
