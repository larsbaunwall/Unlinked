/** Synthetic changelog event builders shaped like live DMA events. No real data. */
export type RawEvent = Record<string, unknown>;

let counter = 1000;

export const MEMBER = "urn:li:person:SyntheticMember1";

export function event(overrides: RawEvent & { resourceName: string; method: string }): RawEvent {
  counter += 1;
  const capturedAt = (overrides.capturedAt as number | undefined) ?? Date.UTC(2026, 8, 20, 10, 0, 0) + counter * 1000;
  return {
    id: counter,
    activityId: `activity-${counter}`,
    activityStatus: "SUCCESS",
    capturedAt,
    processedAt: capturedAt + 5,
    resourceId: String(counter),
    resourceUri: `/${String(overrides.resourceName)}/${counter}`,
    owner: MEMBER,
    actor: MEMBER,
    activity: {},
    ...overrides,
  };
}

export const T = (day: number, hour = 10, minute = 0, second = 0) => Date.UTC(2026, 8, day, hour, minute, second);

export function likeEvent(object: string, opts: { capturedAt: number; method?: string; reactionType?: string; activityId?: string }): RawEvent {
  const method = opts.method ?? "CREATE";
  return event({
    resourceName: "socialActions/likes",
    method,
    capturedAt: opts.capturedAt,
    ...(opts.activityId ? { activityId: opts.activityId } : {}),
    resourceUri: `/socialActions/${object}/likes/${MEMBER}`,
    activity:
      method === "DELETE"
        ? {}
        : { actor: MEMBER, reactionType: opts.reactionType ?? "LIKE", object, root: object, created: { actor: MEMBER } },
  });
}

export function commentEvent(
  object: string,
  id: string,
  text: string,
  opts: { capturedAt: number; method?: string },
): RawEvent {
  const method = opts.method ?? "CREATE";
  return event({
    resourceName: "socialActions/comments",
    method,
    capturedAt: opts.capturedAt,
    resourceId: id,
    resourceUri: `/socialActions/${object}/comments/${id}`,
    activity:
      method === "DELETE"
        ? {}
        : { id, actor: MEMBER, message: { text, attributes: [] }, object, created: { actor: MEMBER, time: opts.capturedAt }, lastModified: {} },
  });
}

export function peopleEvent(activity: RawEvent, capturedAt: number, method = "PARTIAL_UPDATE"): RawEvent {
  return event({ resourceName: "people", method, capturedAt, resourceId: "SyntheticMember1", activity });
}

export function positionEvent(activity: RawEvent, capturedAt: number, resourceId = "9001", method = "PARTIAL_UPDATE"): RawEvent {
  return event({ resourceName: "people/positions", method, capturedAt, resourceId, activity });
}

export function postEvent(
  urn: string,
  text: string | undefined,
  opts: { capturedAt: number; method?: string; visibility?: string; resourceName?: string },
): RawEvent {
  const method = opts.method ?? "CREATE";
  return event({
    resourceName: opts.resourceName ?? "ugcPosts",
    method,
    capturedAt: opts.capturedAt,
    resourceId: urn,
    resourceUri: `/ugcPosts/${urn}`,
    activity:
      method === "DELETE"
        ? {}
        : {
            id: urn,
            author: MEMBER,
            created: { time: opts.capturedAt, actor: MEMBER },
            specificContent: {
              "com.linkedin.ugc.ShareContent": {
                shareCommentary: text === undefined ? {} : { text },
                shareMediaCategory: "NONE",
              },
            },
            visibility: { "com.linkedin.ugc.MemberNetworkVisibility": opts.visibility ?? "PUBLIC" },
          },
  });
}
