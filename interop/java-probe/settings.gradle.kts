// A Java service on jfxmap, for the interop tests of nfxmap. jfxmap is built from its sources, a checkout of
// https://github.com/quyvu01/jfxmap given by -PjfxmapDir (../../../jfxmap by default)
rootProject.name = "java-probe"

includeBuild(providers.gradleProperty("jfxmapDir").getOrElse("../../../jfxmap"))
