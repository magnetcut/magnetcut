// The fullscreen quad, its texture sampled turned clockwise: each point of the
// picture as it's shown, read from where it is in the picture as it's stored.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

fn shown(position: vec2f) -> vec2f {
    return vec2f(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
}

fn output(position: vec2f, tex_coord: vec2f) -> VertexOutput {
    var result: VertexOutput;
    result.position = vec4f(position, 0.0, 1.0);
    result.tex_coord = tex_coord;
    return result;
}

@vertex
fn quarter(@location(0) position: vec2f) -> VertexOutput {
    let point = shown(position);
    return output(position, vec2f(point.y, 1.0 - point.x));
}

@vertex
fn half(@location(0) position: vec2f) -> VertexOutput {
    let point = shown(position);
    return output(position, vec2f(1.0 - point.x, 1.0 - point.y));
}

@vertex
fn three_quarters(@location(0) position: vec2f) -> VertexOutput {
    let point = shown(position);
    return output(position, vec2f(1.0 - point.y, point.x));
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    return textureSample(input_texture, input_sampler, input.tex_coord);
}
