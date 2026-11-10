import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  ddb,
  isMovieItem,
  isRoleItem,
  movieKey,
  parseId,
  tableName,
  toRole,
} from "../shared/db";
import { response } from "../shared/http";
import { logRequest } from "../shared/request-logger";

// GET /movies/{movieID}/roles?[actor=actorID]
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logRequest(event);

  const movieId = parseId(event.pathParameters?.movieID);
  if (movieId === undefined) {
    return response(400, { message: "movieID must be a positive integer" });
  }

  const actorParam = event.queryStringParameters?.actor;
  const actorId = parseId(actorParam);
  if (actorParam !== undefined && actorId === undefined) {
    return response(400, { message: "actor must be a positive integer" });
  }

  try {
    const items = await queryMoviePartition(movieId);
    if (!items.some(isMovieItem)) {
      return response(404, { message: `Movie ${movieId} not found` });
    }

    const roles = items
      .filter(isRoleItem)
      .map(toRole)
      .filter((role) => actorId === undefined || role.actorId === actorId);
    return response(200, { data: roles });
  } catch (err) {
    console.error("DynamoDB error:", err);
    return response(500, { message: "Internal server error" });
  }
};

// All items in the movie's partition (the movie itself plus its roles),
// following LastEvaluatedKey so results over 1MB aren't truncated.
const queryMoviePartition = async (movieId: number) => {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": movieKey(movieId) },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...(page.Items ?? []));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return items;
};
