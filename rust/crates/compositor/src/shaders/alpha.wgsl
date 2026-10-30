// Straight alpha to premultiplied and back, around a transition: mixing
// premultiplied colours keeps a clip's transparent areas from darkening it.
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

@fragment
fn premultiply(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSampleLevel(source_texture, source_sampler, input.tex_coord, 0.0);
    return vec4f(color.rgb * color.a, color.a);
}

@fragment
fn unpremultiply(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSampleLevel(source_texture, source_sampler, input.tex_coord, 0.0);
    if (color.a <= 0.0) {
        return vec4f(0.0);
    }
    return vec4f(clamp(color.rgb / color.a, vec3f(0.0), vec3f(1.0)), color.a);
}
