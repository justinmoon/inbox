import { z } from 'zod';

export const liveThreadRoleSchema = z.enum(['planner', 'implementer', 'reviewer_a', 'reviewer_b']);

export const createLiveChangeUnitRequestSchema = z.object({
  repo_path: z.string().min(1),
  project_name: z.string().min(1).optional(),
  github_repo: z.string().min(1).optional(),
  branch_name: z.string().min(1).optional(),
  thread_ids: z.object({
    planner: z.string().min(1).optional(),
    implementer: z.string().min(1),
    reviewer_a: z.string().min(1).optional(),
    reviewer_b: z.string().min(1).optional(),
  }),
});

export const createLiveChangeUnitResponseSchema = z.object({
  imported: z.string().min(1),
  bundle_path: z.string().min(1),
  project_name: z.string().min(1),
  github_repo: z.string().nullable(),
  branch_name: z.string().nullable(),
});

export type CreateLiveChangeUnitRequest = z.infer<typeof createLiveChangeUnitRequestSchema>;
export type CreateLiveChangeUnitResponse = z.infer<typeof createLiveChangeUnitResponseSchema>;
