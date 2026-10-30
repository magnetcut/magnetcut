// A vignette: the picture darkened towards its corners, from `size` (0 the
// middle, 1 the corners) over `softness`, by `amount`.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureLoad(input_texture, vec2i(input.position.xy), 0);
    let amount = uniforms.scalars.x;
    let size = uniforms.scalars.y;
    let softness = max(uniforms.scalars.z, 0.001);
    // Distance from the middle, the corners at 1, round on any picture.
    let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
    let offset = (input.tex_coord - vec2f(0.5)) * vec2f(aspect, 1.0);
    let distance = length(offset) / length(vec2f(0.5 * aspect, 0.5));
    let shade = smoothstep(size, size + softness, distance) * amount;
    return vec4f(source.rgb * (1.0 - shade), source.a);
}
