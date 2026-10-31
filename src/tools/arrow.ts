import { LineTool } from './line';

/**
 * Arrow tool — draws a straight line with an arrowhead at its end. It's the LineTool
 * with `arrowhead` flipped on, so all the drag/shift-constrain/commit logic is shared;
 * the only difference is the `marker-end` it stamps on the finished line.
 */
export class ArrowTool extends LineTool {
  name = 'arrow';
  protected arrowhead = true;
}
