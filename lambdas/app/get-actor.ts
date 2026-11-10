import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  actorKey,
  ddb,
  movieKey,
  parseId,
  tableName,
  toActor,
  toRole,
} from "../shared/db";
import { response, serverError } from "../shared/http";
import { logRequest } from "../shared/request-logger";

// GET /actors/{actorID}?[movie=movieID]
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logRequest(event);

  const actorId = parseId(event.pathParameters?.actorID);
  if (actorId === undefined) {
    return response(400, { message: "actorID must be a positive integer" });
  }

  const movieParam = event.queryStringParameters?.movie;
  const movieId = parseId(movieParam);
  if (movieParam !== undefined && movieId === undefined) {
    return response(400, { message: "movie must be a positive integer" });
  }

  try {
    const actorItem = await getItem(actorKey(actorId), actorKey(actorId));
    if (!actorItem) {
      return response(404, { message: `Actor ${actorId} not found` });
    }
    const actor = toActor(actorItem);
    if (movieId === undefined) {
      return response(200, { data: actor });
    }

    const [movieItem, roleItem] = await Promise.all([
      getItem(movieKey(movieId), movieKey(movieId)),
      getItem(movieKey(movieId), actorKey(actorId)),
    ]);
    if (!movieItem) {
      return response(404, { message: `Movie ${movieId} not found` });
    }
    // role is null when the actor didn't appear in the movie.
    return response(200, {
      data: { ...actor, role: roleItem ? toRole(roleItem) : null },
    });
  } catch (err) {
    return serverError("DynamoDB error", err);
  }
};

const getItem = async (pk: string, sk: string) => {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } })
  );
  return Item;
};
