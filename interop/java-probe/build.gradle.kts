plugins {
    application
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

// The jfxmap modules come from the included build, whatever the version written here
dependencies {
    implementation("io.github.quyvu01:jfxmap-nats:0.1.0-SNAPSHOT")
    implementation("io.github.quyvu01:jfxmap-rabbitmq:0.1.0-SNAPSHOT")
    implementation("io.github.quyvu01:jfxmap-kafka:0.1.0-SNAPSHOT")
    implementation("io.github.quyvu01:jfxmap-sqs:0.1.0-SNAPSHOT")
    implementation("io.github.quyvu01:jfxmap-azure-servicebus:0.1.0-SNAPSHOT")
    implementation("io.github.quyvu01:jfxmap-opentelemetry:0.1.0-SNAPSHOT")
    implementation("io.opentelemetry:opentelemetry-sdk")
    runtimeOnly("org.slf4j:slf4j-nop:2.0.17")
}

application {
    mainClass = "nfxmap.interop.JavaProbe"
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}
