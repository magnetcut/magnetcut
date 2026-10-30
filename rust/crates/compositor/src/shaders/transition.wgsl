// The fullscreen quad for the gl-transitions shaders: their uv starts at the
// bottom left, as in GL (they flip it to sample).
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vertex_main(@location(0) position: vec2f) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(position, 0.0, 1.0);
    output.uv = position * 0.5 + 0.5;
    return output;
}
