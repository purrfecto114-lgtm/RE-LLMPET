'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'migration-todo.json');
const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
const allowed = new Set(['done', 'implemented-uncompiled', 'blocked', 'todo', 'deferred']);
const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
const byId = new Map();
const errors = [];

for (const task of tasks) {
  if (!task.id || typeof task.id !== 'string') errors.push('Task missing string id');
  else if (byId.has(task.id)) errors.push(`Duplicate task id: ${task.id}`);
  else byId.set(task.id, task);
  if (!allowed.has(task.status)) errors.push(`${task.id}: invalid status ${task.status}`);
  if (!Array.isArray(task.dependencies)) errors.push(`${task.id}: dependencies must be an array`);
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) errors.push(`${task.id}: acceptance evidence is undefined`);
  if (task.status === 'done' && (!Array.isArray(task.evidence) || task.evidence.length === 0)) {
    errors.push(`${task.id}: done task has no evidence`);
  }
  if (task.status === 'blocked' && (!Array.isArray(task.blockedBy) || task.blockedBy.length === 0)) {
    errors.push(`${task.id}: blocked task has no blocker`);
  }
}

for (const task of tasks) {
  for (const dependency of task.dependencies || []) {
    if (!byId.has(dependency)) errors.push(`${task.id}: unknown dependency ${dependency}`);
    if (dependency === task.id) errors.push(`${task.id}: self dependency`);
  }
}

const visiting = new Set();
const visited = new Set();
function visit(id, trail = []) {
  if (visiting.has(id)) {
    errors.push(`Dependency cycle: ${[...trail, id].join(' -> ')}`);
    return;
  }
  if (visited.has(id)) return;
  visiting.add(id);
  const task = byId.get(id);
  if (task) for (const dep of task.dependencies || []) visit(dep, [...trail, id]);
  visiting.delete(id);
  visited.add(id);
}
for (const id of byId.keys()) visit(id);

for (const task of tasks) {
  if (task.status === 'done') {
    for (const evidence of task.evidence || []) {
      if (!fs.existsSync(path.join(root, evidence))) errors.push(`${task.id}: missing evidence path ${evidence}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

const counts = Object.fromEntries([...allowed].map((status) => [status, tasks.filter((task) => task.status === status).length]));
console.log(`migration-todo: ${tasks.length} tasks valid; ${JSON.stringify(counts)}`);
