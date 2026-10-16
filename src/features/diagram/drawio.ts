/**
 * Un diagrama como archivo de draw.io / diagrams.net (`.drawio`, XML de mxGraph sin
 * comprimir), para seguir editándolo allá. Las formas van con los estilos que draw.io trae
 * de fábrica y los grupos como contenedores, con lo de adentro en coordenadas relativas.
 *
 * Puro: se prueba en Node.
 */
import { parentsFirst, type Diagram, type DiagramNode, type Shape } from "./model";
import { PALETTE, edgeColor, groupSwatch, swatch } from "./shapes";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#xa;");

const SHAPE_STYLE: Record<Shape, string> = {
  rect: "rounded=0;whiteSpace=wrap;html=1;",
  rounded: "rounded=1;whiteSpace=wrap;html=1;",
  diamond: "rhombus;whiteSpace=wrap;html=1;",
  ellipse: "ellipse;whiteSpace=wrap;html=1;",
  parallelogram: "shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;",
  cylinder: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;",
  cloud: "ellipse;shape=cloud;whiteSpace=wrap;html=1;",
  actor: "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;",
  document: "shape=document;whiteSpace=wrap;html=1;boundedLbl=1;",
  text: "text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;strokeColor=none;fillColor=none;",
  group: "rounded=1;whiteSpace=wrap;html=1;dashed=1;verticalAlign=top;align=left;spacingLeft=8;fontStyle=1;container=1;collapsible=0;arcSize=4;",
};

function nodeStyle(node: DiagramNode): string {
  const colors = node.shape === "group" ? groupSwatch(node.color) : swatch(node.color);
  const fill = node.shape === "group" ? colors.fill.slice(0, 7) : colors.fill;
  const paint = node.shape === "text" ? `fontColor=${colors.text};` : `fillColor=${fill};strokeColor=${colors.stroke};fontColor=${colors.text};`;
  return `${SHAPE_STYLE[node.shape]}${paint}`;
}

export function toDrawio(diagram: Diagram): string {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  // Los ids de mxGraph: "0" y "1" son las capas raíz; los nuestros van con prefijo para no chocar.
  const cell = (id: string) => `n-${id}`;
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];

  for (const node of parentsFirst(diagram.nodes)) {
    const parent = node.parent ? byId.get(node.parent) : undefined;
    const x = parent ? node.x - parent.x : node.x;
    const y = parent ? node.y - parent.y : node.y;
    cells.push(
      `<mxCell id="${esc(cell(node.id))}" value="${esc(node.label)}" style="${nodeStyle(node)}" vertex="1" parent="${parent ? esc(cell(parent.id)) : "1"}">`
        + `<mxGeometry x="${x}" y="${y}" width="${node.w}" height="${node.h}" as="geometry"/></mxCell>`
    );
  }

  for (const edge of diagram.edges) {
    const arrow = edge.arrow ?? "end";
    const end = arrow === "end" || arrow === "both" ? "endArrow=block;endFill=1;" : "endArrow=none;";
    const start = arrow === "start" || arrow === "both" ? "startArrow=block;startFill=1;" : "startArrow=none;";
    const route = edge.route === "straight" ? "" : edge.route === "curved" ? "curved=1;" : "edgeStyle=orthogonalEdgeStyle;rounded=0;";
    const dashed = edge.style === "dashed" ? "dashed=1;" : "";
    const color = edge.color ? PALETTE[edge.color].stroke : edgeColor(edge);
    cells.push(
      `<mxCell id="${esc(cell(edge.id))}" value="${esc(edge.label ?? "")}" style="${route}html=1;${end}${start}${dashed}strokeColor=${color};" edge="1" parent="1" source="${esc(cell(edge.from))}" target="${esc(cell(edge.to))}">`
        + '<mxGeometry relative="1" as="geometry"/></mxCell>'
    );
  }

  const name = esc(diagram.title ?? "Diagrama");
  return `<mxfile host="Control Code"><diagram id="controlcode" name="${name}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join("")}</root></mxGraphModel></diagram></mxfile>\n`;
}
