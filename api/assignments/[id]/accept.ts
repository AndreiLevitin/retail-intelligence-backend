import { acceptRoute } from '../../../src/http/routes.js'
import { vercelHandler } from '../../../src/http/vercel.js'

const handle = vercelHandler(acceptRoute)
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as OPTIONS }
