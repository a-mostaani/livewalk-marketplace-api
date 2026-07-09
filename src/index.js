import { handleApiRequest } from './routes.js';

async function handle(request, env = {}) {
  return handleApiRequest(request, env);
}

export default { fetch: handle };
export { handle };
