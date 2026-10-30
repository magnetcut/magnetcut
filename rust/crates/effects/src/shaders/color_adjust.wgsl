// The Adjustment tab's colour: exposure and white balance in light (roughly
// linear), then highlights and shadows, contrast, saturation, vibrance and hue
// on the picture as it's encoded. Straight alpha, left as it is.

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    // Exposure, contrast, highlights, shadows: each -1 to 1.
    scalars: vec4f,
    // Saturation, vibrance, temperature, tint (-1 to 1); then hue in degrees.
    extra: array<vec4f, 2>,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

fn luma(color: vec3f) -> f32 {
    return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

/// Turned about the grey axis by `degrees`, in YIQ.
fn turn_hue(color: vec3f, degrees: f32) -> vec3f {
    let y = dot(color, vec3f(0.299, 0.587, 0.114));
    let i = dot(color, vec3f(0.596, -0.274, -0.322));
    let q = dot(color, vec3f(0.211, -0.523, 0.312));
    let angle = radians(degrees);
    let turned_i = i * cos(angle) - q * sin(angle);
    let turned_q = i * sin(angle) + q * cos(angle);
    return vec3f(
        y + 0.956 * turned_i + 0.621 * turned_q,
        y - 0.272 * turned_i - 0.647 * turned_q,
        y - 1.106 * turned_i + 1.703 * turned_q,
    );
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureLoad(input_texture, vec2i(input.position.xy), 0);
    let exposure = uniforms.scalars.x;
    let contrast = uniforms.scalars.y;
    let highlights = uniforms.scalars.z;
    let shadows = uniforms.scalars.w;
    let saturation = uniforms.extra[0].x;
    let vibrance = uniforms.extra[0].y;
    let temperature = uniforms.extra[0].z;
    let tint = uniforms.extra[0].w;
    let hue = uniforms.extra[1].x;

    // Two stops either way; warmer is redder and less blue; tint towards
    // magenta takes green away.
    var light = pow(max(source.rgb, vec3f(0.0)), vec3f(2.2)) * exp2(exposure * 2.0);
    light = light * vec3f(1.0 + temperature * 0.2, 1.0 - tint * 0.15, 1.0 - temperature * 0.2);
    var color = pow(max(light, vec3f(0.0)), vec3f(1.0 / 2.2));

    let level = luma(color);
    let dark = 1.0 - smoothstep(0.0, 0.5, level);
    let bright = smoothstep(0.5, 1.0, level);
    color = color + vec3f(shadows * 0.3 * dark + highlights * 0.3 * bright);

    color = (color - vec3f(0.5)) * (1.0 + contrast) + vec3f(0.5);

    color = mix(vec3f(luma(color)), color, 1.0 + saturation);
    // Vibrance: more for what's less saturated already.
    let spread = clamp(max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b)), 0.0, 1.0);
    color = mix(vec3f(luma(color)), color, 1.0 + vibrance * (1.0 - spread));

    if (hue != 0.0) {
        color = turn_hue(color, hue);
    }
    return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), source.a);
}
