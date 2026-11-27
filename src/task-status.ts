export const taskStatuses = ['Assigned', 'In progress', 'Ready for review', 'Blocked', 'Completed'] as const;
export type TaskStatus = typeof taskStatuses[number];
