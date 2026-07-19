use crate::Algorithm;

pub struct AlgorithmFactory(pub fn() -> Box<dyn Algorithm>);

inventory::collect!(AlgorithmFactory);

pub fn all() -> Vec<Box<dyn Algorithm>> {
    inventory::iter::<AlgorithmFactory>()
        .map(|factory| (factory.0)())
        .collect()
}
